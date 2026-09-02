// Integration test for `runDiffAndPublish` against a real Postgres instance
// (the docker-compose Postgres at host port 5442 — see root docker-compose.yml —
// or whatever `DATABASE_URL` points at). Deliberately named without `.test.`
// so plain `bun test` (this package's `test:unit` script) does not pick it
// up and require a live database; it's wired to this package's
// `test:integration` script instead, which does need one running:
//
//   docker compose up -d
//   bun run --cwd packages/schema db:migrate
//   bun run --cwd apps/control-plane test:integration
//
// Exercises the full loop end to end: insert a fake previous-state row,
// call `runDiffAndPublish` with a reported state that differs, and confirm
// exactly the expected events landed in the `events` table with the right
// `orgId`/`machineId`/`correlationId`, then confirm `lastReportedState`
// was persisted as the new baseline.
import { afterAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, machines, orgs } from "@cloudable/schema";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { Db } from "../db/layer";
import type { MachineReportedState } from "../domain/machine/types";
import { EventBus } from "./EventBus";
import { ReconcileDiffError, runDiffAndPublish } from "./reconcile-diff";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const sql = postgres(databaseUrl);
const db = drizzle(sql, { schema });

const TestDbLive = Layer.succeed(Db, db);
const TestLayer = EventBus.Default.pipe(Layer.provideMerge(TestDbLive));

afterAll(async () => {
  await sql.end();
});

describe("runDiffAndPublish (integration)", () => {
  test("diffs a real previous-state row, publishes events, and persists the new state", async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: "Diff Test Org" })
      .returning({ id: orgs.id });
    if (!org) throw new Error("org insert returned no row");

    const previousState = {
      state: "provisioning" as const,
      packagesHash: "hash-1",
      undeclaredPackages: [] as string[],
      externalResourceId: null as string | null,
      runningAccessMethods: [] as string[],
    };

    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "diff-test-machine",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        state: "provisioning",
        lastReportedState: previousState,
      })
      .returning({ id: machines.id });
    if (!machine) throw new Error("machine insert returned no row");

    try {
      const reported: MachineReportedState = {
        state: "running",
        packagesHash: "hash-2",
        undeclaredPackages: ["nginx"],
        externalResourceId: "azure-vm-abc123",
        runningAccessMethods: ["web_terminal"],
        agentVersion: "1.2.3",
      };

      await Effect.runPromise(Effect.provide(runDiffAndPublish(machine.id, reported), TestLayer));

      const persisted = await db
        .select({
          lastReportedState: machines.lastReportedState,
          lastVerifiedAt: machines.lastVerifiedAt,
        })
        .from(machines)
        .where(eq(machines.id, machine.id));
      expect(persisted[0]?.lastReportedState).toEqual(reported);
      expect(persisted[0]?.lastVerifiedAt).not.toBeNull();

      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.machineId, machine.id), eq(events.orgId, org.id)))
        .orderBy(asc(events.type));

      expect(rows).toHaveLength(2);

      const driftDetected = rows.find((row) => row.type === "machine.drift_detected");
      const stateReported = rows.find((row) => row.type === "machine.state_reported");
      if (!driftDetected || !stateReported) {
        throw new Error("expected both machine.drift_detected and machine.state_reported rows");
      }

      // Both events came from one `runDiffAndPublish` call, so they share a
      // correlation id, and both carry this machine's org/machine ids.
      const correlationId = stateReported.correlationId;
      expect(correlationId).toBeTruthy();
      for (const row of rows) {
        expect(row.orgId).toBe(org.id);
        expect(row.machineId).toBe(machine.id);
        expect(row.correlationId).toBe(correlationId);
        expect(row.actorType).toBe("agent");
        expect(row.actorId).toBe(machine.id);
        expect(row.schemaVersion).toBe(1);
        // The real ULID assigned by EventBus.publish, not deriveEvents's placeholder.
        expect(row.id).not.toBe("");
      }

      expect(driftDetected?.payload).toEqual({
        undeclaredPackages: ["nginx"],
        undeclaredPorts: [],
      });
      expect(stateReported?.payload).toEqual({
        changes: {
          state: { from: "provisioning", to: "running" },
          packagesHash: { from: "hash-1", to: "hash-2" },
          externalResourceId: { from: null, to: "azure-vm-abc123" },
          undeclaredPackages: { from: [], to: ["nginx"] },
          runningAccessMethods: { from: [], to: ["web_terminal"] },
        },
      });

      // Calling again with an identical report is a no-op reconcile: zero
      // additional events.
      await Effect.runPromise(Effect.provide(runDiffAndPublish(machine.id, reported), TestLayer));
      const rowsAfterNoop = await db.select().from(events).where(eq(events.machineId, machine.id));
      expect(rowsAfterNoop).toHaveLength(2);
    } finally {
      // Test-fixture cleanup only — never how production code touches the
      // append-only `events` table (that's exclusively `EventBus.publish`).
      // This just keeps the shared dev database tidy across
      // repeated runs of this integration test.
      await db.delete(events).where(eq(events.machineId, machine.id));
      await db.delete(machines).where(eq(machines.id, machine.id));
      await db.delete(orgs).where(eq(orgs.id, org.id));
    }
  });

  test("unknown machineId fails with machine_not_found and publishes nothing", async () => {
    const reported: MachineReportedState = {
      state: "running",
      packagesHash: "hash-1",
      undeclaredPackages: [],
      externalResourceId: null,
      runningAccessMethods: [],
      agentVersion: "1.2.3",
    };

    const result = await Effect.runPromise(
      Effect.provide(
        runDiffAndPublish("00000000-0000-0000-0000-000000000000", reported),
        TestLayer,
      ).pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ReconcileDiffError);
      expect(result.left.reason).toBe("machine_not_found");
    }
  });
});
