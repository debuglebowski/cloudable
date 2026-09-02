/**
 * The due-date/backoff policy for upgrade attempts. A failed attempt resets
 * the due-date clock exactly as a success does, so a persistently failing
 * machine backs off a full interval instead of retrying every cycle.
 *
 * A success always resets to the base interval and clears the failure
 * streak. A failure grows the wait exponentially with each *consecutive*
 * failure, capped, so a machine that keeps failing is retried less and less
 * often rather than being hammered every scheduler cycle.
 *
 * The concrete interval values are a placeholder cadence — no upgrade
 * scheduler unit exists yet to give them a real-world default, and product
 * may want this org-configurable later (mirroring the retention-days
 * pattern in `packages/schema/src/tables/snapshot.ts`). What matters today,
 * and what's under test, is the shape of the policy: both outcomes advance
 * the clock, and repeated failures back off further each time.
 */
export const UPGRADE_BASE_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
export const UPGRADE_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface BackoffInput {
  outcome: "success" | "failure";
  /** `consecutiveFailures` stored on the immediately preceding attempt row for this machine, or 0 if there is none (or it was a success). */
  previousConsecutiveFailures: number;
}

export interface BackoffResult {
  /** Value to store on this attempt's row — 0 for a success. */
  consecutiveFailures: number;
  intervalMs: number;
}

export function computeBackoff(input: BackoffInput): BackoffResult {
  if (input.outcome === "success") {
    return { consecutiveFailures: 0, intervalMs: UPGRADE_BASE_BACKOFF_MS };
  }
  const consecutiveFailures = input.previousConsecutiveFailures + 1;
  const intervalMs = Math.min(
    UPGRADE_BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
    UPGRADE_MAX_BACKOFF_MS,
  );
  return { consecutiveFailures, intervalMs };
}

export function computeNextEligibleAt(
  now: Date,
  input: BackoffInput,
): { nextEligibleAt: Date; consecutiveFailures: number; intervalMs: number } {
  const { consecutiveFailures, intervalMs } = computeBackoff(input);
  return { nextEligibleAt: new Date(now.getTime() + intervalMs), consecutiveFailures, intervalMs };
}
