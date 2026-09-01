import { describe, expect, test } from "bun:test";
import { DEFAULT_BACKOFF, fullJitterBackoffMs } from "./backoff";

describe("fullJitterBackoffMs", () => {
  test("first attempt stays within [0, base]", () => {
    for (let i = 0; i < 200; i++) {
      const delay = fullJitterBackoffMs(0, { baseMs: 1_000, capMs: 600_000 });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  test("grows exponentially with attempt but never exceeds the cap", () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const delay = fullJitterBackoffMs(attempt, { baseMs: 1_000, capMs: 600_000 });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(600_000);
    }
  });

  test("respects the ~10 min default cap even at high attempt counts", () => {
    const delay = fullJitterBackoffMs(20, DEFAULT_BACKOFF);
    expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF.capMs);
  });

  test("is jitter, not a fixed delay — repeated calls at the same attempt vary", () => {
    const samples = new Set(
      Array.from({ length: 20 }, () => fullJitterBackoffMs(5, { baseMs: 1_000, capMs: 600_000 })),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});
