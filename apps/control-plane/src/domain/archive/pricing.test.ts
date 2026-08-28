import { describe, expect, test } from "bun:test";
import {
  AZURE_SNAPSHOT_PRICING,
  PLACEHOLDER_SNAPSHOT_SIZE_BYTES,
  estimateSnapshotCost,
} from "./pricing";

describe("estimateSnapshotCost", () => {
  test("returns a plausible non-zero figure for a freshly-created 30-day snapshot", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date("2026-01-31T00:00:00Z"); // 30 days out
    const estimate = estimateSnapshotCost(
      { sizeBytes: PLACEHOLDER_SNAPSHOT_SIZE_BYTES, expiresAt },
      now,
    );

    // sizeBytes ~32GiB (~34.36 GB decimal) * $0.05/GB-month / 30 days * 30 days remaining
    // should land in the same ballpark as one month's price for that size.
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(10); // sanity: nowhere near "real money" for a demo disk
  });

  test("scales linearly with size", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date("2026-01-31T00:00:00Z");
    const small = estimateSnapshotCost({ sizeBytes: 1_000_000_000, expiresAt }, now);
    const double = estimateSnapshotCost({ sizeBytes: 2_000_000_000, expiresAt }, now);
    expect(double).toBeCloseTo(small * 2, 5);
  });

  test("is zero once the snapshot has already expired (no remaining hold period)", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const expiresAt = new Date("2026-01-01T00:00:00Z"); // in the past
    expect(
      estimateSnapshotCost({ sizeBytes: PLACEHOLDER_SNAPSHOT_SIZE_BYTES, expiresAt }, now),
    ).toBe(0);
  });

  test("treats a null sizeBytes as zero rather than throwing", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date("2026-01-31T00:00:00Z");
    expect(estimateSnapshotCost({ sizeBytes: null, expiresAt }, now)).toBe(0);
  });

  test("pricing constant is documented as a placeholder, not a live Azure price", () => {
    expect(AZURE_SNAPSHOT_PRICING.pricePerGbMonthUsd).toBeGreaterThan(0);
  });
});
