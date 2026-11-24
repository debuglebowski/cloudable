import { describe, expect, test } from "bun:test";

import { describeState } from "./machine-manifest-tab";

describe("describeState", () => {
  const base = { versionPin: null, locked: false, excluded: false };

  test("Allowed, or no setting recorded, adds nothing", () => {
    expect(describeState(base)).toBe("any version");
    expect(describeState({ ...base, setting: "allowed" })).toBe("any version");
  });

  test("an ensure setting is named", () => {
    expect(describeState({ ...base, versionPin: "2.4", setting: "ensure_installed" })).toBe(
      "2.4, Ensure installed",
    );
    expect(describeState({ ...base, partOf: "gh", setting: "ensure_latest" })).toBe(
      "any version, part of gh, Ensure latest version",
    );
  });

  test("absent and excluded entries", () => {
    expect(describeState(null)).toBe("not declared");
    expect(describeState({ ...base, excluded: true, setting: "ensure_installed" })).toBe(
      "excluded",
    );
  });
});
