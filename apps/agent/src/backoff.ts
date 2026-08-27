/**
 * Exponential backoff with FULL JITTER, ~10 min cap (spec §8.1) — a named
 * invariant, not just a nice-to-have: the failure mode it guards against is
 * every agent in the fleet retrying in lockstep right after a control
 * plane outage ends, immediately causing another one.
 *
 *   backoff = random(0, min(cap, base * 2^attempt))
 *
 * `attempt` is 0 for the first failure, so the first backoff is anywhere
 * from 0 up to `base` — not a fixed delay before the jitter even starts.
 */
export interface BackoffOptions {
  readonly baseMs: number;
  readonly capMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  capMs: 10 * 60 * 1_000, // 10 min
};

export function fullJitterBackoffMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const upperBound = Math.min(options.capMs, options.baseMs * 2 ** attempt);
  return Math.random() * upperBound;
}
