import { describe, expect, test } from "bun:test";
import { computeBackoff, computeNextEligibleAt, UPGRADE_BASE_BACKOFF_MS, UPGRADE_MAX_BACKOFF_MS } from "./backoff";

describe("computeBackoff", () => {
  test("a success always resets to the base interval and clears the streak, regardless of prior failures", () => {
    for (const previousConsecutiveFailures of [0, 1, 5, 100]) {
      expect(computeBackoff({ outcome: "success", previousConsecutiveFailures })).toEqual({
        consecutiveFailures: 0,
        intervalMs: UPGRADE_BASE_BACKOFF_MS,
      });
    }
  });

  test("both success and failure produce a positive interval — every attempt advances the clock", () => {
    expect(computeBackoff({ outcome: "success", previousConsecutiveFailures: 0 }).intervalMs).toBeGreaterThan(0);
    expect(computeBackoff({ outcome: "failure", previousConsecutiveFailures: 0 }).intervalMs).toBeGreaterThan(0);
  });

  test("a first failure backs off by exactly the base interval", () => {
    const result = computeBackoff({ outcome: "failure", previousConsecutiveFailures: 0 });
    expect(result).toEqual({ consecutiveFailures: 1, intervalMs: UPGRADE_BASE_BACKOFF_MS });
  });

  test("repeated consecutive failures back off exponentially — a persistently failing machine waits longer each time, not the same interval every cycle", () => {
    const first = computeBackoff({ outcome: "failure", previousConsecutiveFailures: 0 });
    const second = computeBackoff({ outcome: "failure", previousConsecutiveFailures: first.consecutiveFailures });
    const third = computeBackoff({ outcome: "failure", previousConsecutiveFailures: second.consecutiveFailures });

    expect(second.consecutiveFailures).toBe(2);
    expect(third.consecutiveFailures).toBe(3);
    expect(second.intervalMs).toBeGreaterThan(first.intervalMs);
    expect(third.intervalMs).toBeGreaterThan(second.intervalMs);
    expect(second.intervalMs).toBe(first.intervalMs * 2);
    expect(third.intervalMs).toBe(first.intervalMs * 4);
  });

  test("the backoff interval is capped rather than growing unbounded", () => {
    let consecutiveFailures = 0;
    let intervalMs = 0;
    for (let i = 0; i < 20; i++) {
      const result = computeBackoff({ outcome: "failure", previousConsecutiveFailures: consecutiveFailures });
      consecutiveFailures = result.consecutiveFailures;
      intervalMs = result.intervalMs;
    }
    expect(intervalMs).toBe(UPGRADE_MAX_BACKOFF_MS);
  });

  test("a success after a run of failures resets the streak, so the next failure backs off from the base again", () => {
    const failure1 = computeBackoff({ outcome: "failure", previousConsecutiveFailures: 0 });
    const failure2 = computeBackoff({ outcome: "failure", previousConsecutiveFailures: failure1.consecutiveFailures });
    const success = computeBackoff({ outcome: "success", previousConsecutiveFailures: failure2.consecutiveFailures });
    const failureAfterSuccess = computeBackoff({
      outcome: "failure",
      previousConsecutiveFailures: success.consecutiveFailures,
    });

    expect(failureAfterSuccess).toEqual(failure1);
  });
});

describe("computeNextEligibleAt", () => {
  test("pushes the clock forward from the given `now`, for both outcomes", () => {
    const now = new Date("2026-01-01T00:00:00Z");

    const success = computeNextEligibleAt(now, { outcome: "success", previousConsecutiveFailures: 0 });
    expect(success.nextEligibleAt.getTime()).toBe(now.getTime() + UPGRADE_BASE_BACKOFF_MS);

    const failure = computeNextEligibleAt(now, { outcome: "failure", previousConsecutiveFailures: 0 });
    expect(failure.nextEligibleAt.getTime()).toBeGreaterThan(now.getTime());
  });
});
