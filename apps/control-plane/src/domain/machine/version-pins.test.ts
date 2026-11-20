import { describe, expect, test } from "bun:test";
import { findEnsureSettingProblems } from "./manifest";

describe("version pins per manager", () => {
  test("a pin each manager understands is fine; apt pins stay free text", () => {
    expect(
      findEnsureSettingProblems([
        { packageName: "npm:prettier", setting: "allowed", versionPin: "^3.3.0" },
        { packageName: "pipx:black", setting: "ensure_installed", versionPin: "24.1.0" },
        {
          packageName: "nix:jq",
          setting: "ensure_installed",
          versionPin: "0123456789abcdef0123456789abcdef01234567",
        },
        { packageName: "curl", setting: "allowed", versionPin: "anything apt decides" },
      ]),
    ).toEqual([]);
  });

  test("refuses a pin that is not a version, even on an Allowed entry", () => {
    expect(
      findEnsureSettingProblems([
        { packageName: "npm:prettier", setting: "allowed", versionPin: "3; rm -rf /" },
        { packageName: "nix:jq", setting: "ensure_installed", versionPin: "nixos-unstable" },
      ]).map((problem) => [problem.packageName, problem.reason]),
    ).toEqual([
      ["npm:prettier", "invalid_version_pin"],
      ["nix:jq", "invalid_version_pin"],
    ]);
  });
});
