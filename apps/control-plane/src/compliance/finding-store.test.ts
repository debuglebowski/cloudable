import { beforeEach, describe, expect, test } from "bun:test";
import { _resetForTests, ageInDays, firstSeenAt, pruneClosed } from "./finding-store";

describe("finding-store", () => {
  beforeEach(() => _resetForTests());

  test("firstSeenAt records the first-observed timestamp and returns it on later calls", () => {
    const identity = { checkId: "machines-reporting", orgId: "org-1", machineId: "m-1" };
    const opened = new Date("2026-01-01T00:00:00Z");
    const seenLater = new Date("2026-01-02T00:00:00Z");

    expect(firstSeenAt(identity, opened)).toEqual(opened);
    expect(firstSeenAt(identity, seenLater)).toEqual(opened);
  });

  test("different identities are tracked independently", () => {
    const a = firstSeenAt(
      { checkId: "c1", orgId: "org-1", machineId: "m-1" },
      new Date("2026-01-01T00:00:00Z"),
    );
    const b = firstSeenAt(
      { checkId: "c1", orgId: "org-1", machineId: "m-2" },
      new Date("2026-01-02T00:00:00Z"),
    );
    expect(a).not.toEqual(b);
  });

  test("pruneClosed forgets identities no longer open, so they re-open as new", () => {
    const identity = { checkId: "machines-reporting", orgId: "org-1", machineId: "m-1" };
    const opened = new Date("2026-01-01T00:00:00Z");
    firstSeenAt(identity, opened);

    pruneClosed("machines-reporting", "org-1", new Set());

    const reopened = new Date("2026-02-01T00:00:00Z");
    expect(firstSeenAt(identity, reopened)).toEqual(reopened);
  });

  test("pruneClosed leaves still-open identities untouched", () => {
    const identity = { checkId: "machines-reporting", orgId: "org-1", machineId: "m-1" };
    const opened = new Date("2026-01-01T00:00:00Z");
    firstSeenAt(identity, opened);

    pruneClosed("machines-reporting", "org-1", new Set(["m-1"]));

    expect(firstSeenAt(identity, new Date("2026-02-01T00:00:00Z"))).toEqual(opened);
  });

  test("ageInDays floors to whole days and never goes negative", () => {
    const opened = new Date("2026-01-01T00:00:00Z");
    expect(ageInDays(opened, new Date("2026-01-01T00:00:00Z"))).toBe(0);
    expect(ageInDays(opened, new Date("2026-01-15T12:00:00Z"))).toBe(14);
    expect(ageInDays(opened, new Date("2025-12-31T00:00:00Z"))).toBe(0);
  });
});
