import { NO_MACHINE_SENTINEL, complianceFindingState } from "@cloudable/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../db/layer";

export class FindingStoreError extends Data.TaggedError("FindingStoreError")<{
  reason: string;
  cause?: unknown;
}> {}

/** Identifies one open finding within a check's evaluation of an org. */
export interface FindingKey {
  checkId: string;
  orgId: string;
  machineId: string | null;
  /** Stable identifier derived from the finding's own detail (e.g. a certificate id). */
  detailKey: string;
}

/**
 * Finding-age persistence. Returns the persisted
 * `firstSeenAt` for `key` — an open finding that keeps recurring across
 * evaluations keeps its ORIGINAL detection time, never "now". If this is
 * the first time the finding has been seen, it's inserted stamped `now`
 * and `now` is returned.
 *
 * Implemented as a single atomic `INSERT ... ON CONFLICT DO UPDATE`
 * (`machineId: null` maps to `NO_MACHINE_SENTINEL` so the row's identity
 * columns are all real, non-null values and can back a genuine unique
 * index) rather than a select-then-insert, so two overlapping evaluations
 * of the same finding can't race each other into creating duplicate rows
 * or reading a firstSeenAt that isn't really the first.
 */
export const upsertFindingFirstSeen = (
  key: FindingKey,
): Effect.Effect<Date, FindingStoreError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = new Date();
    const machineId = key.machineId ?? NO_MACHINE_SENTINEL;

    const [row] = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(complianceFindingState)
          .values({
            checkId: key.checkId,
            orgId: key.orgId,
            machineId,
            detailKey: key.detailKey,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [
              complianceFindingState.checkId,
              complianceFindingState.orgId,
              complianceFindingState.machineId,
              complianceFindingState.detailKey,
            ],
            // firstSeenAt is deliberately absent from `set` — only
            // lastSeenAt refreshes on a repeat sighting.
            set: { lastSeenAt: now },
          })
          .returning({ firstSeenAt: complianceFindingState.firstSeenAt }),
      catch: (cause) => new FindingStoreError({ reason: "upsert_failed", cause }),
    });

    if (!row) {
      return yield* Effect.fail(new FindingStoreError({ reason: "upsert_returned_no_row" }));
    }
    return row.firstSeenAt;
  });

/**
 * Removes state rows for (`checkId`, `orgId`) whose `detailKey` is not in
 * `stillOpenDetailKeys` — the finding is no longer detected, so its age
 * bookkeeping shouldn't keep accumulating forever. A check calls this once
 * per evaluation with the full set of detail keys it just computed as
 * still-open, after calling `upsertFindingFirstSeen` for each of them.
 *
 * Only ever touches this bookkeeping table — never `events`, which stays
 * append-only.
 */
export const clearResolvedFindings = (
  checkId: string,
  orgId: string,
  stillOpenDetailKeys: ReadonlyArray<string>,
): Effect.Effect<void, FindingStoreError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const scope = and(
      eq(complianceFindingState.checkId, checkId),
      eq(complianceFindingState.orgId, orgId),
    );

    yield* Effect.tryPromise({
      try: () =>
        db
          .delete(complianceFindingState)
          .where(
            stillOpenDetailKeys.length > 0
              ? and(scope, notInArray(complianceFindingState.detailKey, [...stillOpenDetailKeys]))
              : scope,
          ),
      catch: (cause) => new FindingStoreError({ reason: "delete_failed", cause }),
    });
  });

/** Age in whole days between `firstSeen` and `now` (default: the current time), floored at 0. */
export const ageInDays = (firstSeen: Date, now: Date = new Date()): number =>
  Math.max(0, Math.floor((now.getTime() - firstSeen.getTime()) / 86_400_000));

/**
 * Median age in whole days across a set of open findings' `firstSeenAt`
 * timestamps — surfaces the median age and trend across the audit window,
 * not just the current count. The "N open · oldest Nd" line callers already
 * compute only shows one end of the distribution; this is the other one.
 *
 * A pure function over already-fetched timestamps rather than its own DB
 * read: every check's `evaluate()` now calls `clearResolvedFindings` right
 * after upserting (this unit's fix), so by the time `evaluateAllChecks`
 * returns, a check's `findings` are exactly the rows it currently holds in
 * `compliance_finding_state` — re-querying the table would just re-fetch
 * the same timestamps this call already has.
 *
 * `null` for an empty set, mirroring how callers already treat "oldest
 * open" as absent rather than zero when there are no open findings.
 */
export const medianAgeInDays = (
  firstSeenAts: ReadonlyArray<Date>,
  now: Date = new Date(),
): number | null => {
  if (firstSeenAts.length === 0) return null;

  const ages = firstSeenAts.map((firstSeenAt) => ageInDays(firstSeenAt, now)).sort((a, b) => a - b);
  const mid = Math.floor(ages.length / 2);
  const midAge = ages[mid];
  // `mid` is always a valid index into non-empty `ages` — this is here to
  // satisfy `noUncheckedIndexedAccess` without a non-null assertion.
  if (midAge === undefined) return null;
  if (ages.length % 2 !== 0) return midAge;

  const lowerMidAge = ages[mid - 1];
  return lowerMidAge === undefined ? midAge : (lowerMidAge + midAge) / 2;
};
