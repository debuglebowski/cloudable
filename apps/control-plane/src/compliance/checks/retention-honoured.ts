import { snapshots } from "@cloudable/schema";
import { and, eq, isNull, lt } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { clearResolvedFindings, upsertFindingFirstSeen } from "../finding-store";

const CHECK_ID = "retention-honoured";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Check #5 — "Retention is honoured" (`docs/spec.md` §19).
 *
 * Fails when a snapshot outlives its retention window without a legal hold.
 * `snapshot.expired` is the event that proves hard-deletion happened on
 * schedule, so its absence — `expiredAt IS NULL` — past the `expiresAt`
 * deadline is the failure signal. `legalHold = true` is a documented
 * exception (per spec), not a violation, so those snapshots are excluded.
 */
export const retentionHonouredCheck: ComplianceCheck = {
  id: CHECK_ID,
  label: "Retention is honoured",
  controlRefs: ["asset-management"],

  // Not applicable to an org with no snapshots at all — an org that has
  // never archived a machine has nothing a retention window could apply to.
  appliesTo: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const rows = yield* Effect.tryPromise(() =>
        db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.orgId, orgId)).limit(1),
      ).pipe(Effect.orDie);
      return rows.length > 0;
    }),

  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const now = new Date();

      const overdueSnapshots = yield* Effect.tryPromise(() =>
        db
          .select()
          .from(snapshots)
          .where(
            and(
              eq(snapshots.orgId, orgId),
              lt(snapshots.expiresAt, now),
              isNull(snapshots.expiredAt),
              eq(snapshots.legalHold, false),
            ),
          ),
      ).pipe(Effect.orDie);

      const findings: ComplianceFinding[] = [];
      for (const snapshot of overdueSnapshots) {
        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: CHECK_ID,
          orgId,
          machineId: snapshot.machineId,
          detailKey: snapshot.id,
        }).pipe(Effect.orDie);
        const daysOverdue = Math.floor((now.getTime() - snapshot.expiresAt.getTime()) / MS_PER_DAY);

        findings.push({
          checkId: CHECK_ID,
          orgId,
          machineId: snapshot.machineId,
          firstSeenAt,
          detail: {
            snapshotId: snapshot.id,
            expiresAt: snapshot.expiresAt.toISOString(),
            daysOverdue,
          },
        });
      }

      // Anything previously open for this check+org that isn't among the
      // overdue snapshots found just now has resolved (expired, or placed
      // under legal hold) — stop aging it, so the same snapshot id going
      // overdue again later is treated as newly opened.
      yield* clearResolvedFindings(
        CHECK_ID,
        orgId,
        overdueSnapshots.map((snapshot) => snapshot.id),
      ).pipe(Effect.orDie);

      return findings;
    }),
};
