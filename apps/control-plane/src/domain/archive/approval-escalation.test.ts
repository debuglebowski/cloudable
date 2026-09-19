import { describe, expect, test } from "bun:test";
import { resolveRestoreApprovalFloor } from "./approval-escalation";

describe("resolveRestoreApprovalFloor — by mode", () => {
  test("data mode has no floor — the org's own configured policy applies unmodified, including 'none'", () => {
    expect(resolveRestoreApprovalFloor("data", "new_machine")).toBe("none");
  });

  test("config mode floors at 'single'", () => {
    expect(resolveRestoreApprovalFloor("config", "new_machine")).toBe("single");
  });

  test("full mode is always 'dual'", () => {
    expect(resolveRestoreApprovalFloor("full", "new_machine")).toBe("dual");
  });

  test("escalation is monotonic: data <= config <= full", () => {
    const rank = { none: 0, single: 1, dual: 2 } as const;
    const data = rank[resolveRestoreApprovalFloor("data", "new_machine")];
    const config = rank[resolveRestoreApprovalFloor("config", "new_machine")];
    const full = rank[resolveRestoreApprovalFloor("full", "new_machine")];
    expect(data).toBeLessThanOrEqual(config);
    expect(config).toBeLessThanOrEqual(full);
  });

  test("full never resolves below 'single'", () => {
    expect(resolveRestoreApprovalFloor("full", "new_machine")).not.toBe("none");
  });
});

describe("resolveRestoreApprovalFloor — by target", () => {
  test("overwriting a live machine is always 'dual', even for the mode with no floor at all", () => {
    // The destructive case: a data restore onto a running machine destroys the /home it
    // currently has. The org cannot configure its way below two approvers for that.
    expect(resolveRestoreApprovalFloor("data", "live_machine")).toBe("dual");
  });

  test("an archived target keeps the mode's own floor — its disks are already gone, so nothing is destroyed", () => {
    expect(resolveRestoreApprovalFloor("data", "archived_machine")).toBe("none");
    expect(resolveRestoreApprovalFloor("config", "archived_machine")).toBe("single");
  });

  test("a new machine keeps the mode's own floor — nothing existing is touched", () => {
    expect(resolveRestoreApprovalFloor("data", "new_machine")).toBe("none");
  });

  test("the two axes clamp up, never down — a live target never weakens full's dual", () => {
    expect(resolveRestoreApprovalFloor("full", "live_machine")).toBe("dual");
    expect(resolveRestoreApprovalFloor("config", "live_machine")).toBe("dual");
  });

  test("for every mode, a live target is at least as strong as any other target", () => {
    const rank = { none: 0, single: 1, dual: 2 } as const;
    for (const mode of ["data", "config", "full"] as const) {
      const live = rank[resolveRestoreApprovalFloor(mode, "live_machine")];
      expect(live).toBeGreaterThanOrEqual(rank[resolveRestoreApprovalFloor(mode, "new_machine")]);
      expect(live).toBeGreaterThanOrEqual(
        rank[resolveRestoreApprovalFloor(mode, "archived_machine")],
      );
    }
  });
});
