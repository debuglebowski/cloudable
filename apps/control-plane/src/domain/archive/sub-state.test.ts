import { describe, expect, test } from "bun:test";
import { getSnapshotSubState, restoreUnavailableReason } from "./sub-state";

describe("getSnapshotSubState", () => {
  test("is 'restorable' when expiredAt is not set", () => {
    expect(getSnapshotSubState({ expiredAt: null })).toBe("restorable");
  });

  test("is 'expired' once expiredAt is set", () => {
    expect(getSnapshotSubState({ expiredAt: new Date("2026-01-01T00:00:00Z") })).toBe("expired");
  });
});

describe("restoreUnavailableReason", () => {
  test("is null for a restorable snapshot — restore is available, no reason needed", () => {
    expect(restoreUnavailableReason({ expiredAt: null })).toBeNull();
  });

  test("gives a stated, human-readable reason for an expired snapshot — never just a flag", () => {
    const reason = restoreUnavailableReason({ expiredAt: new Date("2026-01-01T00:00:00Z") });
    expect(reason).not.toBeNull();
    expect(reason).toContain("2026-01-01");
    expect(reason?.toLowerCase()).toContain("expired");
  });
});
