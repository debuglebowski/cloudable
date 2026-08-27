/**
 * Minimal "finding first seen" tracker.
 *
 * Compliance checks are computed live from current fleet state, not stored
 * (docs/spec.md §19), so nothing about a check's pass/fail result is
 * persisted. But an open finding still needs a stable "first seen"
 * timestamp so it can be displayed as "open 14d" instead of resetting to
 * "just now" on every evaluation (docs/spec.md §19, "Finding age").
 *
 * This is deliberately the smallest thing that could work: a process-
 * lifetime `Map` keyed by (checkId, orgId, machineId). It is NOT durable —
 * a control-plane restart forgets every finding's history and treats it as
 * newly opened on the next evaluation. Unit 7's real `finding-store.ts` (a
 * DB-backed table surviving restarts) supersedes this; at merge time keep
 * whichever implementation is fuller rather than keeping both.
 */

export interface FindingIdentity {
  readonly checkId: string;
  readonly orgId: string;
  readonly machineId: string | null;
}

const firstSeenByKey = new Map<string, Date>();

const keyOf = (id: FindingIdentity): string => `${id.checkId}::${id.orgId}::${id.machineId ?? "-"}`;

/**
 * Returns the timestamp this finding identity was first observed as open.
 * Records `observedAt` (default: now) the first time a given identity is
 * seen, and returns that same timestamp on every subsequent call — until
 * `pruneClosed` drops it because the finding stopped appearing.
 */
export const firstSeenAt = (id: FindingIdentity, observedAt: Date = new Date()): Date => {
  const key = keyOf(id);
  const existing = firstSeenByKey.get(key);
  if (existing) return existing;
  firstSeenByKey.set(key, observedAt);
  return observedAt;
};

/**
 * Drops tracked first-seen timestamps for a check/org whose finding is no
 * longer open, so a finding that closes and later reopens is treated as
 * newly opened rather than carrying its old age. Call with the full set of
 * machine ids the check just reported as still open (empty set clears all
 * tracked identities for this check/org).
 */
export const pruneClosed = (
  checkId: string,
  orgId: string,
  stillOpenMachineIds: ReadonlySet<string>,
): void => {
  const prefix = `${checkId}::${orgId}::`;
  for (const key of firstSeenByKey.keys()) {
    if (!key.startsWith(prefix)) continue;
    const machineId = key.slice(prefix.length);
    if (!stillOpenMachineIds.has(machineId)) {
      firstSeenByKey.delete(key);
    }
  }
};

/** Age in whole days between `firstSeen` and `now` (default: the current time), floored at 0. */
export const ageInDays = (firstSeen: Date, now: Date = new Date()): number =>
  Math.max(0, Math.floor((now.getTime() - firstSeen.getTime()) / 86_400_000));

/** Test-only: reset all tracked state so tests don't leak first-seen timestamps across cases. */
export const _resetForTests = (): void => firstSeenByKey.clear();
