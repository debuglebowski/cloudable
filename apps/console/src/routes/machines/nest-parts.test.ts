import { describe, expect, test } from "bun:test";
import type { MachinePackageRow } from "@/api/machines";
import { nestParts } from "./machine-packages-table";

const row = (packageName: string, partOf: string | null = null): MachinePackageRow => ({
  packageName,
  permission: "allowed",
  versionPin: null,
  source: "machine",
  installed: "installed",
  versionMismatch: false,
  isBaseline: false,
  partOf,
});

describe("nestParts", () => {
  test("parts follow their parent; order otherwise kept", () => {
    const rows = [row("xvfb", "npm:playwright"), row("gh"), row("npm:playwright"), row("a", "b")];
    expect(nestParts(rows).map((r) => r.packageName)).toEqual([
      "gh",
      "npm:playwright",
      "xvfb",
      "a",
    ]);
  });

  test("a cycle is shown, not lost", () => {
    expect(
      nestParts([row("a", "b"), row("b", "a")])
        .map((r) => r.packageName)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
