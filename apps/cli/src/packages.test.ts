import { expect, test } from "bun:test";
import { parseArgs } from "./args";
import { packageEdits, parsePackageArg } from "./machines";

test("a package argument carries its pin with it", () => {
  expect(parsePackageArg("curl", false)).toEqual({
    packageName: "curl",
    versionPin: null,
    pinned: false,
  });
  expect(parsePackageArg("curl@8.5.0", true)).toEqual({
    packageName: "curl",
    versionPin: "8.5.0",
    pinned: true,
  });
});

test("a scoped name keeps its leading @", () => {
  expect(parsePackageArg("@scope/pkg@1.2.3", false)).toEqual({
    packageName: "@scope/pkg",
    versionPin: "1.2.3",
    pinned: false,
  });
  expect(parsePackageArg("@scope/pkg", false).versionPin).toBeNull();
});

test("--add, --pin and --remove become one edit", () => {
  const args = parseArgs(["--add", "jq", "--pin", "curl@8.5.0", "--remove", "vim"], {
    repeatable: ["add", "pin", "remove"],
  });
  const { upserts, removals } = packageEdits(args);
  expect(upserts).toEqual([
    { packageName: "jq", versionPin: null, pinned: false },
    { packageName: "curl", versionPin: "8.5.0", pinned: true },
  ]);
  expect(removals).toEqual(["vim"]);
});

test("--exclude and --include are upserts, not removals", () => {
  const args = parseArgs(["--exclude", "docker", "--include", "nodejs"], {
    repeatable: ["add", "pin", "remove", "exclude", "include"],
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
