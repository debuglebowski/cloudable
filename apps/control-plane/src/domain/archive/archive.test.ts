import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { machines, orgs } from "@cloudable/schema";
import { inArray } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import type { ProvisioningService } from "../../services/ProvisioningService";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { archiveMachine } from "./archive";

/**
 * Regression coverage for a real, already-live bug found while fixing the
 * reconcile loop's identical mistake: `archiveMachine()` used to call
 * `provisioning.archive(machineId, machine.provider)` with no third
 * argument at all. The azure adapter would then recompute the wrong VM
 * resource name, 404, and this function's own `not_found` handler (meant
 * for "the resource is genuinely already gone") would silently treat that
 * as success — marking the DB row archived while the real VM kept running,
 * untouched, forever. This asserts the actual argument threaded through,
 * independent of what any particular adapter does with it.
 *
 * Runs against the docker-compose Postgres, same convention as this
 * directory's other tests (e.g. `restore.test.ts`) — every test seeds its
 * own fresh org/machine, no isolated database needed.
 */
describe("archiveMachine — threads externalResourceId to the provisioning port (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
      await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    }
    await sql.end();
  });

  async function seedOrgAndMachine(externalResourceId: string | null) {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    createdOrgIds.push(org.id);

    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "m1",
        provider: "azure",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        state: "running",
        externalResourceId,
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  // Records BOTH port calls an archive now makes. `createSnapshot` copies the disks
  // through `snapshot()` before `archive()` tears anything down, and the same
  // "never re-derive a name, pass the id we stored" rule applies to both — a snapshot
  // aimed at a guessed name copies nothing and reports success.
  function spyProvisioning() {
    const calls: Array<{
      op: "snapshot" | "archive";
      machineId: string;
      provider: string;
      externalId: string | null;
    }> = [];
    const provisioning: ProvisioningService = {
      snapshot: (desc) => {
        calls.push({
          op: "snapshot",
          machineId: desc.machineId,
          provider: desc.provider,
          externalId: desc.externalId,
        });
        return Effect.succeed({
          disks: [{ kind: "data" as const, externalId: "snap-1", sizeBytes: 123 }],
          sizeBytes: 123,
        });
      },
      create: () => Effect.die("not used in this test"),
      // Not exercised here — inspection has its own tests. `die` rather than a stub
      // result so an unexpected call fails loudly instead of passing silently.
      grantSnapshotRead: () => Effect.die("grantSnapshotRead not stubbed in this test"),
      revokeSnapshotRead: () => Effect.die("revokeSnapshotRead not stubbed in this test"),
      archive: (machineId, provider, externalId) => {
        calls.push({ op: "archive", machineId, provider, externalId });
        return Effect.succeed({ machineId, state: "archived", externalId });
      },
      reconcile: () => Effect.die("not used in this test"),
      reimage: () => Effect.die("not used in this test"),
      restart: () => Effect.die("not used in this test"),
    };
    return { calls, provisioning };
  }

  test("passes the machine's stored externalResourceId, not nothing", async () => {
    const machine = await seedOrgAndMachine("/subscriptions/x/.../virtualMachines/cldm-m1-abc123");
    const { calls, provisioning } = spyProvisioning();
    const dbLayer = Layer.succeed(Db, db);
    const testLayer = Layer.mergeAll(
      dbLayer,
      Layer.succeed(ProvisioningServiceTag, provisioning),
      Layer.provide(EventBus.Default, dbLayer),
    );

    await Effect.runPromise(Effect.provide(archiveMachine(machine.id), testLayer));

    // Snapshot first, then teardown — the order matters more than either call: a
    // teardown that runs first destroys the disks the snapshot was meant to copy.
    expect(calls).toEqual([
      {
        op: "snapshot",
        machineId: machine.id,
        provider: "azure",
        externalId: "/subscriptions/x/.../virtualMachines/cldm-m1-abc123",
      },
      {
        op: "archive",
        machineId: machine.id,
        provider: "azure",
        externalId: "/subscriptions/x/.../virtualMachines/cldm-m1-abc123",
      },
    ]);
  });

  test("passes null (not a wrong guess) when externalResourceId was never recorded", async () => {
    const machine = await seedOrgAndMachine(null);
    const { calls, provisioning } = spyProvisioning();
    const dbLayer = Layer.succeed(Db, db);
    const testLayer = Layer.mergeAll(
      dbLayer,
      Layer.succeed(ProvisioningServiceTag, provisioning),
      Layer.provide(EventBus.Default, dbLayer),
    );

    await Effect.runPromise(Effect.provide(archiveMachine(machine.id), testLayer));

    expect(calls).toEqual([
      { op: "snapshot", machineId: machine.id, provider: "azure", externalId: null },
      { op: "archive", machineId: machine.id, provider: "azure", externalId: null },
    ]);
  });
});
