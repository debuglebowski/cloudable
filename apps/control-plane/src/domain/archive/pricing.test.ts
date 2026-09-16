import { describe, expect, test } from "bun:test";
import { AZURE_SNAPSHOT_PRICING, estimateSnapshotCost } from "./pricing";

/** A real Azure OS-disk figure (30 GiB, as `az snapshot list` reports it), standing in
 * for the hardcoded THIRTY_GIB this suite used to import. That
 * constant is gone: `createSnapshot` records the size the provider actually reports. */
const THIRTY_GIB = 32_213_303_296;

describe("estimateSnapshotCost", () => {
  test("returns a plausible non-zero figure for a freshly-created 30-day snapshot", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date("2026-01-31T00:00:00Z"); // 30 days out
    const estimate = estimateSnapshotCost({ sizeBytes: THIRTY_GIB, expiresAt }, now);

    // ~30 GiB (~32.2 GB decimal) * $0.05/GB-month / 30 days * 30 days remaining
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
    expect(estimateSnapshotCost({ sizeBytes: THIRTY_GIB, expiresAt }, now)).toBe(0);
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

// ---------------------------------------------------------------------------
// Sizing, which is what the estimate above is only as good as.
//
// The bug: `sizeBytes` is the PROVISIONED size of the disks a snapshot copied. Every
// machine gets the same 64 GiB data disk, so every snapshot in the fleet reported an
// identical figure whatever was on it — and the cost estimate then multiplied that
// ceiling by a per-GB price. A provider bills a full snapshot on used data, so the
// measured number is both the honest size and the billable one.
// ---------------------------------------------------------------------------
describe("estimateSnapshotCost against measured rather than provisioned size", () => {
  const expiresAt = new Date("2026-01-31T00:00:00Z");
  const now = new Date("2026-01-01T00:00:00Z");

  test("a near-empty volume costs orders of magnitude less than its disk suggests", () => {
    // A real observation: cosmic-otter's persistent volume held 52 KiB on a 64 GiB disk.
    const provisioned = estimateSnapshotCost({ sizeBytes: 68_719_476_736, expiresAt }, now);
    const measured = estimateSnapshotCost({ sizeBytes: 53_248, expiresAt }, now);

    expect(provisioned).toBeGreaterThan(3);
    expect(measured).toBe(0);
    expect(measured).toBeLessThan(provisioned);
  });
});
