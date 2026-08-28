import { describe, expect, test } from "bun:test";
import { resolveRestoreApprovalFloor } from "./approval-escalation";

describe("resolveRestoreApprovalFloor", () => {
  test("data mode uses the org's own policy unmodified, including 'none'", () => {
    expect(resolveRestoreApprovalFloor("data", "none")).toBe("none");
    expect(resolveRestoreApprovalFloor("data", "single")).toBe("single");
    expect(resolveRestoreApprovalFloor("data", "dual")).toBe("dual");
  });

  test("config mode floors at 'single' even when the org policy is 'none'", () => {
    expect(resolveRestoreApprovalFloor("config", "none")).toBe("single");
  });

  test("config mode passes through the org policy when it's already 'single' or higher", () => {
    expect(resolveRestoreApprovalFloor("config", "single")).toBe("single");
    expect(resolveRestoreApprovalFloor("config", "dual")).toBe("dual");
  });

  test("full mode is always 'dual', regardless of org policy", () => {
    expect(resolveRestoreApprovalFloor("full", "none")).toBe("dual");
    expect(resolveRestoreApprovalFloor("full", "single")).toBe("dual");
    expect(resolveRestoreApprovalFloor("full", "dual")).toBe("dual");
  });

  test("escalation is monotonic: data <= config <= full for every org policy", () => {
    const rank = { none: 0, single: 1, dual: 2 } as const;
    for (const orgPolicy of ["none", "single", "dual"] as const) {
      const data = rank[resolveRestoreApprovalFloor("data", orgPolicy)];
      const config = rank[resolveRestoreApprovalFloor("config", orgPolicy)];
      const full = rank[resolveRestoreApprovalFloor("full", orgPolicy)];
      expect(data).toBeLessThanOrEqual(config);
      expect(config).toBeLessThanOrEqual(full);
    }
  });

  test("full never resolves below 'single'", () => {
    for (const orgPolicy of ["none", "single", "dual"] as const) {
      expect(resolveRestoreApprovalFloor("full", orgPolicy)).not.toBe("none");
    }
  });
});
