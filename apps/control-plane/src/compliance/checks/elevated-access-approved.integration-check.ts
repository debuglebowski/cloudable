import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { events, approvals } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ulid } from "ulid";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { elevatedAccessApprovedCheck } from "./elevated-access-approved";

// Integration test — spins up a real Postgres via testcontainers (see
// `test/testcontainers.ts`). `ComplianceCheck.evaluate` is a query over
// `Db`, not something meaningfully fakeable in-memory.
describe("elevatedAccessApprovedCheck", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  const evaluate = (orgId: string) =>
    Effect.runPromise(
      Effect.provide(elevatedAccessApprovedCheck.evaluate({ orgId }), Layer.succeed(Db, testDb.db)),
    );

  const insertElevationGranted = (opts: {
    orgId: string;
    machineId: string;
    correlationId: string;
    approvalId: string | null;
  }) =>
    testDb.db.insert(events).values({
      id: ulid(),
      type: "access.elevation_granted",
      occurredAt: new Date(),
      orgId: opts.orgId,
      actorType: "person",
      actorId: "person-1",
      machineId: opts.machineId,
      correlationId: opts.correlationId,
      schemaVersion: 1,
      payload: { level: "shell", expiresAt: new Date().toISOString(), approvalId: opts.approvalId },
    });

  const insertApprovalGranted = (opts: { orgId: string; correlationId: string }) =>
    testDb.db.insert(events).values({
      id: ulid(),
      type: "approval.granted",
      occurredAt: new Date(),
      orgId: opts.orgId,
      actorType: "person",
      actorId: "approver-1",
      machineId: null,
      correlationId: opts.correlationId,
      schemaVersion: 1,
      payload: { approverIds: ["approver-1"], actionType: "break_glass" },
    });

  const insertApproval = async (opts: { orgId: string; reason: string }) => {
    const [row] = await testDb.db
      .insert(approvals)
      .values({
        orgId: opts.orgId,
        actionType: "break_glass",
        mode: "single",
        status: "approved",
        requestedByPersonId: randomUUID(),
        targetMachineId: null,
        reason: opts.reason,
        requiredApprovals: 1,
        expiresAt: new Date(Date.now() + 60_000),
        decidedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("expected approval insert to return a row");
    return row;
  };

  test("elevation with a matching, reasoned, approved approval -> no finding", async () => {
    const orgId = randomUUID();
    const correlationId = randomUUID();
    const machineId = randomUUID();
    const approval = await insertApproval({ orgId, reason: "on-call incident #123" });
    await insertElevationGranted({ orgId, machineId, correlationId, approvalId: approval.id });
    await insertApprovalGranted({ orgId, correlationId });

    expect(await evaluate(orgId)).toEqual([]);
  });

  test("elevation with no matching approval.granted event -> finding", async () => {
    const orgId = randomUUID();
    const correlationId = randomUUID();
    const machineId = randomUUID();
    const approval = await insertApproval({ orgId, reason: "on-call incident #124" });
    await insertElevationGranted({ orgId, machineId, correlationId, approvalId: approval.id });
    // Deliberately no approval.granted event sharing this correlationId.

    const findings = await evaluate(orgId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("elevated-access-approved");
    expect(findings[0]?.machineId).toBe(machineId);
    expect(findings[0]?.detail).toMatchObject({ missingApproval: true, missingReason: false });
  });

  test("elevation with an approval that has an empty reason -> finding", async () => {
    const orgId = randomUUID();
    const correlationId = randomUUID();
    const machineId = randomUUID();
    const approval = await insertApproval({ orgId, reason: "" });
    await insertElevationGranted({ orgId, machineId, correlationId, approvalId: approval.id });
    await insertApprovalGranted({ orgId, correlationId });

    const findings = await evaluate(orgId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatchObject({ missingApproval: false, missingReason: true });
  });

  test("an org with no elevation events -> no findings", async () => {
    expect(await evaluate(randomUUID())).toEqual([]);
  });

  // Regression test for the finding-age reopen bug (docs/compliance.md,
  // "a finding that closes and later reopens is treated as newly opened"):
  // without `clearResolvedFindings`, the state row from the first
  // detection survives the resolution and the reopened finding reports the
  // ORIGINAL, stale `firstSeenAt` instead of a fresh one. The elevation
  // event itself is immutable (events are append-only), so resolve/reopen
  // is driven by mutating the referenced `approvals.reason` — the same
  // approval record the check reads live.
  test("closes and reopens -> firstSeenAt resets, not the stale original", async () => {
    const orgId = randomUUID();
    const correlationId = randomUUID();
    const machineId = randomUUID();
    const approval = await insertApproval({ orgId, reason: "" });
    await insertElevationGranted({ orgId, machineId, correlationId, approvalId: approval.id });
    await insertApprovalGranted({ orgId, correlationId });

    const opened = await evaluate(orgId);
    expect(opened).toHaveLength(1);
    const firstSeenAt = opened[0]?.firstSeenAt;

    // Resolve: the approval gets a real reason.
    await testDb.db
      .update(approvals)
      .set({ reason: "on-call incident #125" })
      .where(eq(approvals.id, approval.id));
    expect(await evaluate(orgId)).toEqual([]);

    // Reopen: the reason is cleared again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await testDb.db.update(approvals).set({ reason: "" }).where(eq(approvals.id, approval.id));
    const reopened = await evaluate(orgId);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.firstSeenAt.getTime()).not.toBe(firstSeenAt?.getTime());
    expect(reopened[0]?.firstSeenAt.getTime()).toBeGreaterThan(firstSeenAt?.getTime() ?? 0);
  });
});
