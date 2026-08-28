import { describe, expect, test } from "bun:test";
import { computeControlMap } from "./control-map";

describe("computeControlMap", () => {
  test("marks a control implemented once a registered check evidences it", () => {
    const map = computeControlMap([
      { id: "no-undeclared-software", controlRefs: ["asset-management"] },
    ]);

    const assetManagement = map.find((c) => c.id === "asset-management");
    expect(assetManagement?.status).toBe("implemented");
    expect(assetManagement?.evidencedByCheckIds).toEqual(["no-undeclared-software"]);
  });

  test("marks an in-scope control manual_action_required with no registered checks", () => {
    const map = computeControlMap([]);

    const accessManagement = map.find((c) => c.id === "access-management");
    expect(accessManagement?.status).toBe("manual_action_required");
    expect(accessManagement?.evidencedByCheckIds).toEqual([]);
  });

  test("out-of-scope controls are always not_covered, regardless of registered checks", () => {
    const map = computeControlMap([{ id: "some-future-check", controlRefs: ["hr-screening"] }]);

    const hrScreening = map.find((c) => c.id === "hr-screening");
    expect(hrScreening?.status).toBe("not_covered");
    expect(hrScreening?.evidencedByCheckIds).toEqual([]);
  });

  test("works with an empty registry (no other units merged yet)", () => {
    const map = computeControlMap([]);
    expect(map.length).toBeGreaterThan(0);
    expect(
      map.every((c) => c.status === "manual_action_required" || c.status === "not_covered"),
    ).toBe(true);
  });

  test("a check can evidence multiple controls", () => {
    const map = computeControlMap([
      { id: "multi-control-check", controlRefs: ["access-management", "asset-management"] },
    ]);
    expect(map.find((c) => c.id === "access-management")?.status).toBe("implemented");
    expect(map.find((c) => c.id === "asset-management")?.status).toBe("implemented");
  });
});
