import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { machines, orgs, settingValues } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { ApprovalService, settingKeyFor } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { restoreSnapshot } from "./restore";
import { createSnapshot } from "./snapshot";

/**
 * Regression coverage for the escalation-enforcement fix: `restoreSnapshot()` used to
 * compute the right approval floor per restore mode (`resolveRestoreApprovalFloor`) but
 * only ever wrote it into the approval's free-text `reason` — the actual gate was one
 * shared org-wide `approval_mode:snapshot_restore` setting applied identically to every
 * restore mode. An org that set that setting to `"none"` could therefore get a `"full"`
 * restore (secret bindings reattached) auto-approved with zero human review, directly
 * contradicting the intent that full restores be deliberately hardest to reach.
 *
 * Runs against the docker-compose Postgres, same convention as
 * `services/ApprovalService.test.ts` — this suite doesn't need an isolated database
 * (every test seeds its own fresh org/machine).
 */
describe("restoreSnapshot — approval escalation floor (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db | EventBus | ApprovalService>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    TestLayer = Layer.mergeAll(
      dbLayer,
      Layer.provide(EventBus.Default, dbLayer),
      Layer.provide(ApprovalService.Default, dbLayer),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ApprovalService>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  async function seedMachine(orgId: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  /** Sets the ONE real gate — `ApprovalService`'s own `approval_mode:snapshot_restore`
   * setting — that every restore mode shares before this unit's escalation floor is
   * layered on top of it. */
  async function setRestoreApprovalMode(orgId: string, mode: "none" | "single" | "dual") {
    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: orgId,
      key: settingKeyFor("snapshot_restore"),
      value: mode,
      source: "org",
    });
  }

  const approvalStatusOf = (approvalId: string, orgId: string) =>
    run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        return yield* approvalService.status(approvalId, orgId);
      }),
    );

  test("the exact regression: mode 'full' is NOT auto-approved even when the org's snapshot_restore mode is 'none' — it still requires dual sign-off", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const machine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(machine.id, "manual"));

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "full",
        targetMachineId: machine.id,
        requestedByPersonId: crypto.randomUUID(),
        reason: "full restore attempted under a none-mode org policy",
        confirmSecretBindings: true,
      }),
    );

    // The bug: this used to come back "approved" / restored: true with zero human
    // review, purely because the org's shared setting was "none".
    expect(result.approvalStatus).toBe("pending");
    expect(result.restored).toBe(false);

    const approval = await approvalStatusOf(result.approvalId, org.id);
    expect(approval.mode).toBe("dual");
    expect(approval.requiredApprovals).toBe(2);
    expect(approval.status).toBe("pending");
  });

  test("mode 'config' floors at 'single' even when the org's snapshot_restore mode is 'none'", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const machine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(machine.id, "manual"));

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "config",
        targetMachineId: machine.id,
        requestedByPersonId: crypto.randomUUID(),
        reason: "config restore attempted under a none-mode org policy",
      }),
    );

    expect(result.approvalStatus).toBe("pending");
    const approval = await approvalStatusOf(result.approvalId, org.id);
    expect(approval.mode).toBe("single");
    expect(approval.requiredApprovals).toBe(1);
  });

  test("mode 'data' is NOT escalated: the org's own 'none' policy is honored unmodified, auto-approving", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const machine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(machine.id, "manual"));

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        targetMachineId: machine.id,
        requestedByPersonId: crypto.randomUUID(),
        reason: "data restore attempted under a none-mode org policy",
      }),
    );

    expect(result.approvalStatus).toBe("approved");
    expect(result.restored).toBe(true);
  });

  test("mode 'full' still requires BOTH sign-offs when the org's mode is already 'dual' — the floor never lowers what the org itself configured", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "dual");
    const machine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(machine.id, "manual"));
    const approverA = crypto.randomUUID();
    const approverB = crypto.randomUUID();

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "full",
        targetMachineId: machine.id,
        requestedByPersonId: crypto.randomUUID(),
        reason: "full restore under an already-dual org policy",
        confirmSecretBindings: true,
      }),
    );
    expect(result.approvalStatus).toBe("pending");

    await run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        yield* approvalService.decide(result.approvalId, org.id, approverA, "approved");
      }),
    );
    expect((await approvalStatusOf(result.approvalId, org.id)).status).toBe("pending");

    await run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        yield* approvalService.decide(result.approvalId, org.id, approverB, "approved");
      }),
    );
    expect((await approvalStatusOf(result.approvalId, org.id)).status).toBe("approved");
  });
});
