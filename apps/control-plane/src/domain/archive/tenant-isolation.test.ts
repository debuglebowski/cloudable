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
import { isDbReachable } from "../../testing/db-reachable";
import { InvalidRestoreApprovalError, MachineNotFoundError, SnapshotNotFoundError } from "./errors";
import { fetchMachine, fetchSnapshot } from "./queries";
import { restoreSnapshot, resumeRestore } from "./restore";
import { clearLegalHold, createSnapshot, setLegalHold } from "./snapshot";

// Real Postgres, not a fake — the behaviour under test is this session's
// tenant-isolation fixes (`fetchMachine`/`fetchSnapshot`'s optional `orgId`
// check, `setLegalHold`/`clearLegalHold`'s required one, and
// `restoreSnapshot`'s new same-org-as-snapshot check on the restore
// target), which only matter against the real tables.
const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("archive — tenant isolation (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db | EventBus | ApprovalService>;

  beforeAll(() => {
    sql = postgres(databaseUrl);
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

  const runFail = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ApprovalService>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  /** `machines.owner_person_id` is nullable at the schema level (application-level
   * `MachineService.create` requires one, but this domain doesn't) — a bare insert
   * is enough for archive/snapshot tests, which never read ownership. */
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

  /** Forces `approval_mode:snapshot_restore` to `"single"` for `orgId` — the
   * default is already `"single"` (`DEFAULT_APPROVAL_MODE`), but pinning it
   * explicitly makes `resumeRestore`'s tests deterministic regardless of
   * that default ever changing. */
  async function forceSingleRestoreApprovalMode(orgId: string) {
    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: orgId,
      key: settingKeyFor("snapshot_restore"),
      value: "single",
      source: "org",
    });
  }

  test("fetchMachine/fetchSnapshot: an org id that doesn't match resolves to not-found, same as an unknown id", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();
    const machine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(machine.id, "manual"));

    // Own org: resolves normally.
    const ownMachine = await run(fetchMachine(machine.id, org.id));
    expect(ownMachine.id).toBe(machine.id);
    const ownSnapshot = await run(fetchSnapshot(snapshot.id, org.id));
    expect(ownSnapshot.id).toBe(snapshot.id);

    // Different org: not-found, not a leak of the real row.
    const machineError = await runFail(fetchMachine(machine.id, otherOrg.id));
    expect(machineError).toBeInstanceOf(MachineNotFoundError);
    const snapshotError = await runFail(fetchSnapshot(snapshot.id, otherOrg.id));
    expect(snapshotError).toBeInstanceOf(SnapshotNotFoundError);
  });

  test("setLegalHold/clearLegalHold against a different org's snapshot fail with SnapshotNotFoundError, and never change it", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();
    const machine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(machine.id, "manual"));

    const setError = await runFail(setLegalHold(snapshot.id, otherOrg.id, "wrong org"));
    expect(setError).toBeInstanceOf(SnapshotNotFoundError);

    const stillNoHold = await run(fetchSnapshot(snapshot.id, org.id));
    expect(stillNoHold.legalHold).toBe(false);

    // Now place it for real, then confirm the wrong org can't clear it either.
    await run(setLegalHold(snapshot.id, org.id, "under investigation"));
    const clearError = await runFail(clearLegalHold(snapshot.id, otherOrg.id, "wrong org"));
    expect(clearError).toBeInstanceOf(SnapshotNotFoundError);

    const stillHeld = await run(fetchSnapshot(snapshot.id, org.id));
    expect(stillHeld.legalHold).toBe(true);
  });

  test("restoreSnapshot refuses a target machine that belongs to a different org than the snapshot", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();
    const sourceMachine = await seedMachine(org.id);
    const foreignTargetMachine = await seedMachine(otherOrg.id);
    const snapshot = await run(createSnapshot(sourceMachine.id, "manual"));

    const error = await runFail(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        targetMachineId: foreignTargetMachine.id,
        requestedByPersonId: crypto.randomUUID(),
        reason: "attempting a cross-tenant restore",
      }),
    );
    expect(error).toBeInstanceOf(MachineNotFoundError);
  });

  test("restoreSnapshot proceeds normally when the target machine is in the snapshot's own org", async () => {
    const org = await seedOrg();
    const sourceMachine = await seedMachine(org.id);
    const targetMachine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(sourceMachine.id, "manual"));

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        targetMachineId: targetMachine.id,
        requestedByPersonId: crypto.randomUUID(),
        reason: "legitimate same-org restore",
      }),
    );
    expect(result.snapshotId).toBe(snapshot.id);
    expect(["pending", "approved"]).toContain(result.approvalStatus);
  });

  test("resumeRestore: a pending restore is a no-op until the approval is decided, then completes it", async () => {
    const org = await seedOrg();
    await forceSingleRestoreApprovalMode(org.id);
    const sourceMachine = await seedMachine(org.id);
    const targetMachine = await seedMachine(org.id);
    const snapshot = await run(createSnapshot(sourceMachine.id, "manual"));
    const requestedByPersonId = crypto.randomUUID();

    const pending = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        targetMachineId: targetMachine.id,
        requestedByPersonId,
        reason: "resume test",
      }),
    );
    expect(pending.approvalStatus).toBe("pending");
    expect(pending.restored).toBe(false);

    // Still pending: no-op, same shape back.
    const stillPending = await run(resumeRestore(pending.approvalId, org.id));
    expect(stillPending.approvalStatus).toBe("pending");
    expect(stillPending.restored).toBe(false);

    // Decide it directly through ApprovalService (no HTTP layer in this test).
    await run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        yield* approvalService.decide(pending.approvalId, org.id, requestedByPersonId, "approved");
      }),
    );

    const resumed = await run(resumeRestore(pending.approvalId, org.id));
    expect(resumed.approvalStatus).toBe("approved");
    expect(resumed.restored).toBe(true);
    expect(resumed.snapshotId).toBe(snapshot.id);
    expect(resumed.targetMachineId).toBe(targetMachine.id);

    // Idempotent: calling again finds it already completed, doesn't re-publish.
    const resumedAgain = await run(resumeRestore(pending.approvalId, org.id));
    expect(resumedAgain.restored).toBe(true);
  });

  test("resumeRestore rejects an approval id that isn't a snapshot_restore approval", async () => {
    const org = await seedOrg();
    const targetMachine = await seedMachine(org.id);

    // A break_glass approval, unrelated to any restore request.
    const foreignApproval = await run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        return yield* approvalService.request({
          orgId: org.id,
          actionType: "break_glass",
          requestedByPersonId: crypto.randomUUID(),
          targetMachineId: targetMachine.id,
          reason: "unrelated approval",
        });
      }),
    );

    const error = await runFail(resumeRestore(foreignApproval.id, org.id));
    expect(error).toBeInstanceOf(InvalidRestoreApprovalError);
  });

  test("resumeRestore rejects a completely nonexistent approval id the same way (not a defect)", async () => {
    const org = await seedOrg();
    const error = await runFail(resumeRestore(crypto.randomUUID(), org.id));
    expect(error).toBeInstanceOf(InvalidRestoreApprovalError);
  });
});
