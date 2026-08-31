import { describe, expect, test } from "bun:test";
import {
  type ControlMapEntry,
  OVERRIDABLE_CONTROL_IDS,
  applyControlOverrides,
  computeControlMap,
} from "./control-map";

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

/** Matches `applyControlOverrides`'s own per-entry `overridable` derivation, for building
 * expected values in tests without hand-listing which two ids are in scope. */
const withDefaultOverrideFields = (entry: ControlMapEntry) => ({
  ...entry,
  overridden: false,
  overridable: OVERRIDABLE_CONTROL_IDS.has(entry.id),
});

describe("applyControlOverrides", () => {
  test("with no override, a control's status matches the computed default exactly", () => {
    const defaultMap = computeControlMap([]);
    const withOverrides = applyControlOverrides(defaultMap, []);

    expect(withOverrides).toEqual(defaultMap.map(withDefaultOverrideFields));
  });

  test("an override flips only the targeted control's status and marks it overridden", () => {
    const defaultMap = computeControlMap([]);
    const withOverrides = applyControlOverrides(defaultMap, [
      { controlId: "access-management", status: "not_covered" },
    ]);

    const accessManagement = withOverrides.find((c) => c.id === "access-management");
    expect(accessManagement?.status).toBe("not_covered");
    expect(accessManagement?.overridden).toBe(true);
    expect(accessManagement?.overridable).toBe(true);

    // Every other control is untouched — same status, same evidencedByCheckIds, not overridden.
    const others = withOverrides.filter((c) => c.id !== "access-management");
    expect(others).toEqual(
      defaultMap.filter((c) => c.id !== "access-management").map(withDefaultOverrideFields),
    );
  });

  test("overriding an implemented control away clears evidencedByCheckIds — it must not still read as evidenced", () => {
    const defaultMap = computeControlMap([
      { id: "no-undeclared-software", controlRefs: ["asset-management"] },
    ]);
    expect(defaultMap.find((c) => c.id === "asset-management")?.evidencedByCheckIds).toEqual([
      "no-undeclared-software",
    ]);

    const withOverrides = applyControlOverrides(defaultMap, [
      { controlId: "asset-management", status: "not_covered" },
    ]);
    const assetManagement = withOverrides.find((c) => c.id === "asset-management");
    expect(assetManagement?.status).toBe("not_covered");
    // An org that explicitly overrode this control away from "implemented" must not
    // still see the automated check listed as evidence underneath it — the console's
    // Audit page renders a non-empty evidencedByCheckIds as live check evidence.
    expect(assetManagement?.evidencedByCheckIds).toEqual([]);
  });

  test("an override landing back on implemented keeps the real evidencedByCheckIds", () => {
    const defaultMap = computeControlMap([
      { id: "no-undeclared-software", controlRefs: ["asset-management"] },
    ]);
    const withOverrides = applyControlOverrides(defaultMap, [
      { controlId: "asset-management", status: "implemented" },
    ]);

    expect(withOverrides.find((c) => c.id === "asset-management")?.evidencedByCheckIds).toEqual([
      "no-undeclared-software",
    ]);
  });

  test("is a pure merge with no opinion on which control ids are eligible for override — that's enforced by control-overrides-store.ts's OVERRIDABLE_CONTROL_IDS guard before a row is ever persisted, not here", () => {
    const defaultMap = computeControlMap([]);
    const withOverrides = applyControlOverrides(defaultMap, [
      { controlId: "hr-screening", status: "implemented" },
    ]);

    const hrScreening = withOverrides.find((c) => c.id === "hr-screening");
    // The merge itself is naive — it applies whatever override it's handed. `overridable`
    // still correctly reports false, so a caller like the console's override UI can tell
    // not to have offered this in the first place, even for an entry that (only in this
    // synthetic test, never in the real write path) ended up overridden anyway.
    expect(hrScreening?.status).toBe("implemented");
    expect(hrScreening?.overridden).toBe(true);
    expect(hrScreening?.overridable).toBe(false);
  });
});
