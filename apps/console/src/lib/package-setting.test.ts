import { describe, expect, test } from "bun:test";

import { describeSettingChange, formatNextTry, settingUnavailableReason } from "./package-setting";

describe("settingUnavailableReason", () => {
  test("Allowed always fits", () => {
    expect(
      settingUnavailableReason("allowed", { packageName: "npm:x", versionPin: "1" }),
    ).toBeNull();
  });

  test("ensure settings are apt only", () => {
    for (const name of ["npm:playwright", "pipx:ruff", "cargo:just", "home:tool"]) {
      expect(
        settingUnavailableReason("ensure_installed", { packageName: name, versionPin: null }),
      ).not.toBeNull();
    }
    expect(
      settingUnavailableReason("ensure_installed", { packageName: "ripgrep", versionPin: "14" }),
    ).toBeNull();
  });

  test("Ensure latest version cannot take a version pin", () => {
    expect(
      settingUnavailableReason("ensure_latest", { packageName: "ripgrep", versionPin: "14" }),
    ).not.toBeNull();
    expect(
      settingUnavailableReason("ensure_latest", { packageName: "ripgrep", versionPin: null }),
    ).toBeNull();
  });
});

describe("describeSettingChange", () => {
  const approval = (status: "pending" | "approved" | "rejected" | "expired") => [
    { packageName: "gh", approvalId: "a1", status },
  ];

  test("a pending approval says it waits", () => {
    const outcome = describeSettingChange("gh", "ensure_installed", approval("pending"));
    expect(outcome.kind).toBe("success");
    expect(outcome.title).toBe('Asked to set "gh" to Ensure installed');
    expect(outcome.description).toContain("Waiting for approval");
  });

  test("approved at once, or back to Allowed, says it is set", () => {
    expect(describeSettingChange("gh", "ensure_latest", approval("approved")).title).toBe(
      '"gh" set to Ensure latest version',
    );
    expect(describeSettingChange("gh", "allowed", []).title).toBe('"gh" set to Allowed');
  });

  test("a refused approval is an error", () => {
    expect(describeSettingChange("gh", "ensure_installed", approval("rejected")).kind).toBe(
      "error",
    );
  });
});

describe("formatNextTry", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");

  test("future times read as in N units", () => {
    expect(formatNextTry("2026-11-20T17:00:00Z", now)).toBe("in 5h");
    expect(formatNextTry("2026-11-22T12:00:00Z", now)).toBe("in 2d");
    expect(formatNextTry("2026-11-20T12:30:00Z", now)).toBe("in 30m");
  });

  test("past or imminent times read as soon", () => {
    expect(formatNextTry("2026-11-20T11:00:00Z", now)).toBe("soon");
    expect(formatNextTry("2026-11-20T12:00:30Z", now)).toBe("soon");
  });
});
