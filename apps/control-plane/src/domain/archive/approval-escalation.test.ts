import { describe, expect, test } from "bun:test";
import { resolveRestoreApprovalFloor } from "./approval-escalation";

describe("resolveRestoreApprovalFloor", () => {
  test("data mode has no floor — the org's own configured policy applies unmodified, including 'none'", () => {
    expect(resolveRestoreApprovalFloor("data")).toBe("none");
  });

  test("config mode floors at 'single'", () => {
    expect(resolveRestoreApprovalFloor("config")).toBe("single");
  });

  test("full mode is always 'dual'", () => {
    expect(resolveRestoreApprovalFloor("full")).toBe("dual");
  });

  test("escalation is monotonic: data <= config <= full", () => {
    const rank = { none: 0, single: 1, dual: 2 } as const;
    const data = rank[resolveRestoreApprovalFloor("data")];
    const config = rank[resolveRestoreApprovalFloor("config")];
    const full = rank[resolveRestoreApprovalFloor("full")];
    expect(data).toBeLessThanOrEqual(config);
    expect(config).toBeLessThanOrEqual(full);
  });

  test("full never resolves below 'single'", () => {
    expect(resolveRestoreApprovalFloor("full")).not.toBe("none");
  });
});
