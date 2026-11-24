import { expect, test } from "bun:test";
import { parseArgs } from "./args";
import { describeEnsureApprovals, packageEdits, parsePackageArg } from "./machines";

test("a package argument carries its pin with it", () => {
  expect(parsePackageArg("curl", false)).toEqual({
    packageName: "curl",
    versionPin: null,
    locked: false,
  });
  expect(parsePackageArg("curl@8.5.0", true)).toEqual({
    packageName: "curl",
    versionPin: "8.5.0",
    locked: true,
  });
});

test("a scoped name keeps its leading @", () => {
  expect(parsePackageArg("@scope/pkg@1.2.3", false)).toEqual({
    packageName: "@scope/pkg",
    versionPin: "1.2.3",
    locked: false,
  });
  expect(parsePackageArg("@scope/pkg", false).versionPin).toBeNull();
});

test("--add, --lock and --remove become one edit", () => {
  const args = parseArgs(["--add", "jq", "--lock", "curl@8.5.0", "--remove", "vim"], {
    repeatable: ["add", "lock", "remove"],
  });
  const { upserts, removals } = packageEdits(args);
  expect(upserts).toEqual([
    { packageName: "jq", versionPin: null, locked: false },
    { packageName: "curl", versionPin: "8.5.0", locked: true },
  ]);
  expect(removals).toEqual(["vim"]);
});

test("--exclude and --include are upserts, not removals", () => {
  const args = parseArgs(["--exclude", "docker", "--include", "nodejs"], {
    repeatable: ["add", "lock", "remove", "exclude", "include"],
  });
  const { upserts, removals } = packageEdits(args);
  // Neither carries a version or pin: an omitted field keeps whatever the
  // machine's own row already had, so excluding never wipes a pin.
  expect(upserts).toEqual([
    { packageName: "docker", excluded: true },
    { packageName: "nodejs", excluded: false },
  ]);
  expect(removals).toEqual([]);
});

test("--ensure, --ensure-latest and --allow send only the setting", () => {
  const args = parseArgs(["--ensure", "ripgrep", "--ensure-latest", "git", "--allow", "jq"], {
    repeatable: ["add", "lock", "remove", "ensure", "ensure-latest", "allow"],
  });
  const { upserts, removals } = packageEdits(args);
  // No version or pin: an omitted field keeps whatever the row already had, so
  // ensuring a locked package keeps its pin.
  expect(upserts).toEqual([
    { packageName: "ripgrep", setting: "ensure_installed" },
    { packageName: "git", setting: "ensure_latest" },
    { packageName: "jq", setting: "allowed" },
  ]);
  expect(removals).toEqual([]);
});

test("each ensure approval is one plain line", () => {
  const upserts = [
    { packageName: "ripgrep", setting: "ensure_installed" as const },
    { packageName: "git", setting: "ensure_latest" as const },
  ];
  expect(
    describeEnsureApprovals(
      [
        { packageName: "ripgrep", approvalId: "ap-1", status: "pending" },
        { packageName: "git", approvalId: "ap-2", status: "approved" },
      ],
      upserts,
    ),
  ).toEqual(["ripgrep: waiting for approval ap-1", "git: set to Ensure latest version"]);
  expect(describeEnsureApprovals([], upserts)).toEqual([]);
});

test("a prefixed npm name keeps its scope; a pin after it still splits", () => {
  expect(parsePackageArg("npm:@openai/codex", false)).toEqual({
    packageName: "npm:@openai/codex",
    versionPin: null,
    locked: false,
  });
  expect(parsePackageArg("npm:@openai/codex@0.5.0", false).versionPin).toBe("0.5.0");
});

test("--part-of applies to every add and lock; --standalone clears a parent", () => {
  const args = parseArgs(
    [
      "--add",
      "xvfb",
      "--add",
      "home:playwright-chromium",
      "--part-of",
      "npm:playwright",
      "--standalone",
      "gh",
    ],
    { values: ["part-of"], repeatable: ["add", "lock", "remove", "standalone"] },
  );
  expect(packageEdits(args).upserts).toEqual([
    { packageName: "xvfb", versionPin: null, locked: false, partOf: "npm:playwright" },
    {
      packageName: "home:playwright-chromium",
      versionPin: null,
      locked: false,
      partOf: "npm:playwright",
    },
    { packageName: "gh", partOf: null },
  ]);
});

test("--description applies to every add in the command", () => {
  const args = parseArgs(["--add", "gh", "--description", "GitHub CLI for PR work"], {
    values: ["part-of", "description"],
    repeatable: ["add", "lock", "remove", "standalone"],
  });
  expect(packageEdits(args).upserts).toEqual([
    { packageName: "gh", versionPin: null, locked: false, description: "GitHub CLI for PR work" },
  ]);
});
