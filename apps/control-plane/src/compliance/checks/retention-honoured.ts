import { snapshots } from "@cloudable/schema";
import { and, eq, isNull, lt } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { upsertFindingFirstSeen } from "../finding-store";

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
  // Data outliving its declared retention window is a real compliance
  // exposure, but a slower-burning one than live unauthorised access — medium.
  severity: "medium",
  controlRefs: ["asset-management"],
  appliesTo: () => Effect.succeed(true),
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

      return findings;
    }),
};
