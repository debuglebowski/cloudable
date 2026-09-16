import { describe, expect, test } from "bun:test";
import { formatSnapshotSize } from "./snapshot-format";

describe("formatSnapshotSize", () => {
  // The bug this display has now told three different ways. First it showed a
  // hardcoded 32 GiB as "34.4 GB" on every snapshot in the fleet. Then it showed the
  // provisioned disk size, identical on every machine. Then it showed the placeholder
  // again as "34.4 GB max", which reads like a measured ceiling and is not one.
  test("a snapshot that copied nothing reports no size at all", () => {
    expect(
      formatSnapshotSize({ sizeBytes: 34_359_738_368, usedBytes: null, capturedDiskCount: 0 }),
    ).toBe("not recorded");
  });

  test("real disks, unmeasured contents -> the provisioned size as an explicit ceiling", () => {
    expect(
      formatSnapshotSize({ sizeBytes: 100_932_780_032, usedBytes: null, capturedDiskCount: 2 }),
    ).toBe("100.9 GB max");
  });

  test("measured -> the real figure, at a unit that can express it", () => {
    // 52 KiB, the real contents of a fresh machine's home directory. The old formatter
    // bottomed out at MB and would have rendered this "0 MB".
    expect(
      formatSnapshotSize({ sizeBytes: 68_719_476_736, usedBytes: 53_248, capturedDiskCount: 1 }),
    ).toBe("53.2 kB");
  });

  test("measured beats provisioned even when the disk is large", () => {
    expect(
      formatSnapshotSize({
        sizeBytes: 68_719_476_736,
        usedBytes: 2_100_000_000,
        capturedDiskCount: 1,
      }),
    ).toBe("2.1 GB");
  });
});
