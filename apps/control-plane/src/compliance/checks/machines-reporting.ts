import { machines } from "@cloudable/schema";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { firstSeenAt, pruneClosed } from "../finding-store";

export const CHECK_ID = "machines-reporting";

/**
 * How stale `lastVerifiedAt` must be before a machine is flagged as no
 * longer reporting.
 *
 * The control agent polls roughly every 30s (docs/spec.md §8.1: "Poll ~30s
 * with ETag / version check"), backing off exponentially with jitter up to
 * a ~10 minute cap on failure. Five minutes is comfortably more than a
 * single missed poll or a short burst of jittered backoff would explain,
 * but still well inside the ~10 minute backoff cap — so a machine that has
 * genuinely stopped reporting (not just backing off from one transient
 * blip) is flagged promptly rather than only after the cap is reached.
 * ~10x the happy-path poll interval, named so the reasoning travels with
 * the number instead of living only in a commit message.
 */
export const REPORTING_STALENESS_THRESHOLD_MINUTES = 5;

/**
 * Machines in these states are not expected to report — they no longer run
 * a control agent. Excluding them keeps the check from flagging machines
 * that were correctly archived.
 */
const NOT_EXPECTED_TO_REPORT_STATES = ["archived_restorable", "archived_expired"] as const;

const thresholdCutoff = (now: Date): Date =>
  new Date(now.getTime() - REPORTING_STALENESS_THRESHOLD_MINUTES * 60_000);

/**
 * Check #6 — "Machines are reporting" (docs/spec.md §19). Deliberately NOT
 * an event query: it reads current state directly off the `machines` table,
 * since a machine that has *stopped* emitting anything is exactly the
 * failure mode an events-only query would miss.
 */
export const machinesReportingCheck: ComplianceCheck = {
  id: CHECK_ID,
  label: "Machines are reporting",
  controlRefs: ["asset-management"],

  // Always applicable: any org with a live fleet expects it to check in,
  // and an org with no live machines simply has nothing to flag below.
  appliesTo: () => Effect.succeed(true),

  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const now = new Date();
      const cutoff = thresholdCutoff(now);

      const stale = yield* Effect.promise(() =>
        db
          .select({ id: machines.id, lastVerifiedAt: machines.lastVerifiedAt })
          .from(machines)
          .where(
            and(
              eq(machines.orgId, orgId),
              ne(machines.state, NOT_EXPECTED_TO_REPORT_STATES[0]),
              ne(machines.state, NOT_EXPECTED_TO_REPORT_STATES[1]),
              or(
                // Reported before, but has since gone stale.
                lt(machines.lastVerifiedAt, cutoff),
                // Never reported at all — only stale once it's been in the
                // fleet long enough that a first check-in was actually due.
                // Without the `createdAt` guard, every machine still in
                // `provisioning` (lastVerifiedAt is null until the agent's
                // first poll) would fail this check the instant it's
                // created, before the agent has had any chance to report.
                and(isNull(machines.lastVerifiedAt), lt(machines.createdAt, cutoff)),
              ),
            ),
          ),
      );

      pruneClosed(CHECK_ID, orgId, new Set(stale.map((machine) => machine.id)));

      return stale.map(
        (machine): ComplianceFinding => ({
          checkId: CHECK_ID,
          orgId,
          machineId: machine.id,
          firstSeenAt: firstSeenAt({ checkId: CHECK_ID, orgId, machineId: machine.id }, now),
          detail: {
            lastVerifiedAt: machine.lastVerifiedAt ? machine.lastVerifiedAt.toISOString() : null,
            thresholdMinutes: REPORTING_STALENESS_THRESHOLD_MINUTES,
          },
        }),
      );
    }),
};
