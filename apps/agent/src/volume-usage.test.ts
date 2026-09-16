import { describe, expect, test } from "bun:test";
import { readVolumeUsage } from "./volume-usage";

describe("readVolumeUsage", () => {
  test("measures a real filesystem", () => {
    // "/" exists on every platform this can run on, including the mac a developer
    // runs `bun test` on, so this needs no fixture and no mock.
    const usage = readVolumeUsage("/");
    expect(usage).toBeDefined();
    if (!usage) return;
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.usedBytes).toBeGreaterThan(0);
    // The property the whole change exists for: used is a measurement of contents,
    // not the size of the container. A snapshot recorded at `totalBytes` is the bug.
    expect(usage.usedBytes).toBeLessThan(usage.totalBytes);
  });

  test("reports nothing rather than throwing when the path does not exist", () => {
    // A machine that cannot measure must still be able to report everything else —
    // and "could not look" must never be recorded as a measurement of zero.
    expect(readVolumeUsage("/no/such/path/on/any/machine")).toBeUndefined();
  });
});
