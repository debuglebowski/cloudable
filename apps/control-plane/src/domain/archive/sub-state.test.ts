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

// ---------------------------------------------------------------------------
// A snapshot that captured nothing.
//
// Six rows in production were written before `createSnapshot` ever called a provider:
// a row, a retention clock, a "restorable" badge and a Restore button, standing over
// nothing at all. `restoreUnavailableReason` only looked at `expiredAt`, so it returned
// null for every one of them — the console's own contract is "grey out restore WITH the
// reason", and there was no reason to show.
// ---------------------------------------------------------------------------
describe("restoreUnavailableReason for a snapshot that captured nothing", () => {
  test("refuses, and does not claim data was deleted", () => {
    const reason = restoreUnavailableReason({ expiredAt: null, capturedDisks: [] });
    expect(reason).not.toBeNull();
    expect(reason).toContain("nothing to restore from");
    // The expiry wording says the volume data "was hard-deleted", which asserts the
    // data once existed. For these rows that is false.
    expect(reason).not.toContain("hard-deleted");
  });

  test("captured-nothing is checked before expiry, so the reason stays truthful", () => {
    const reason = restoreUnavailableReason({
      expiredAt: new Date("2026-01-01T00:00:00Z"),
      capturedDisks: [],
    });
    expect(reason).toContain("nothing to restore from");
    expect(reason).not.toContain("hard-deleted");
  });

  test("a snapshot with real disks and no expiry is still restorable", () => {
    expect(
      restoreUnavailableReason({
        expiredAt: null,
        capturedDisks: [{ kind: "data", externalId: "/snapshots/x", sizeBytes: 1 }],
      }),
    ).toBeNull();
  });
});
