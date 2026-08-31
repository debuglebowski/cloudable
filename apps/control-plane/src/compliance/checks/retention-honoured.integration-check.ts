import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { snapshots } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { retentionHonouredCheck } from "./retention-honoured";

// Integration test — spins up a real Postgres via testcontainers (see
// `test/testcontainers.ts`). `ComplianceCheck.evaluate` is a query over
// `Db`, not something meaningfully fakeable in-memory.
describe("retentionHonouredCheck", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  const evaluate = (orgId: string) =>
    Effect.runPromise(
      Effect.provide(retentionHonouredCheck.evaluate({ orgId }), Layer.succeed(Db, testDb.db)),
    );

  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const insertSnapshot = async (opts: {
    orgId: string;
    machineId: string;
    expiresAt: Date;
    expiredAt: Date | null;
    legalHold: boolean;
  }) => {
    const [row] = await testDb.db
      .insert(snapshots)
      .values({
        orgId: opts.orgId,
        machineId: opts.machineId,
        trigger: "archive",
        region: "eastus",
        retentionDays: 30,
        expiresAt: opts.expiresAt,
        expiredAt: opts.expiredAt,
        legalHold: opts.legalHold,
      })
      .returning();
    if (!row) throw new Error("expected snapshot insert to return a row");
    return row;
  };

  test("snapshot past retention with no legal hold -> finding", async () => {
    const orgId = randomUUID();
    const machineId = randomUUID();
    const snapshot = await insertSnapshot({
      orgId,
      machineId,
      expiresAt: daysAgo(5),
      expiredAt: null,
      legalHold: false,
    });

    const findings = await evaluate(orgId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("retention-honoured");
    expect(findings[0]?.machineId).toBe(machineId);
    expect(findings[0]?.detail).toMatchObject({ snapshotId: snapshot.id, daysOverdue: 5 });
  });

  test("snapshot past retention WITH legal hold -> no finding (documented exception)", async () => {
    const orgId = randomUUID();
    const machineId = randomUUID();
    await insertSnapshot({
      orgId,
      machineId,
      expiresAt: daysAgo(5),
      expiredAt: null,
      legalHold: true,
    });

    expect(await evaluate(orgId)).toEqual([]);
  });

  test("snapshot already expired (expiredAt set) -> no finding", async () => {
    const orgId = randomUUID();
    const machineId = randomUUID();
    await insertSnapshot({
      orgId,
      machineId,
      expiresAt: daysAgo(5),
      expiredAt: daysAgo(4),
      legalHold: false,
    });

    expect(await evaluate(orgId)).toEqual([]);
  });

  test("snapshot not yet past retention -> no finding", async () => {
    const orgId = randomUUID();
    const machineId = randomUUID();
    await insertSnapshot({
      orgId,
      machineId,
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      expiredAt: null,
      legalHold: false,
    });

    expect(await evaluate(orgId)).toEqual([]);
  });

  // Regression test for the finding-age reopen bug (docs/compliance.md,
  // "a finding that closes and later reopens is treated as newly opened"):
  // without `clearResolvedFindings`, the state row from the first overdue
  // period survives the resolution and the reopened finding reports the
  // ORIGINAL, stale `firstSeenAt` instead of a fresh one. `legalHold` is a
  // mutable flag on the same snapshot row, so toggling it resolves/reopens
  // the finding without ever touching `events`.
  test("closes and reopens -> firstSeenAt resets, not the stale original", async () => {
    const orgId = randomUUID();
    const machineId = randomUUID();
    const snapshot = await insertSnapshot({
      orgId,
      machineId,
      expiresAt: daysAgo(5),
      expiredAt: null,
      legalHold: false,
    });

    const opened = await evaluate(orgId);
    expect(opened).toHaveLength(1);
    const firstSeenAt = opened[0]?.firstSeenAt;

    // Resolve: place the snapshot under legal hold.
    await testDb.db.update(snapshots).set({ legalHold: true }).where(eq(snapshots.id, snapshot.id));
    expect(await evaluate(orgId)).toEqual([]);

    // Reopen: lift the hold again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await testDb.db
      .update(snapshots)
      .set({ legalHold: false })
      .where(eq(snapshots.id, snapshot.id));
    const reopened = await evaluate(orgId);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.firstSeenAt.getTime()).not.toBe(firstSeenAt?.getTime());
    expect(reopened[0]?.firstSeenAt.getTime()).toBeGreaterThan(firstSeenAt?.getTime() ?? 0);
  });
});
