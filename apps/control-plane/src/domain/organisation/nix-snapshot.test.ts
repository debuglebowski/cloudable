import { describe, expect, test } from "bun:test";
import { effectiveNixSnapshot, isValidNixSnapshot, nixpkgsCommitFor } from "./nix-snapshot";

const ORG = "0123456789abcdef0123456789abcdef01234567";
const PIN = "fedcba9876543210fedcba9876543210fedcba98";

describe("nix snapshot", () => {
  test("only a full commit, or null to clear", () => {
    expect(isValidNixSnapshot(ORG)).toBe(true);
    expect(isValidNixSnapshot(null)).toBe(true);
    expect(isValidNixSnapshot("nixos-24.05")).toBe(false);
    expect(isValidNixSnapshot(ORG.slice(0, 12))).toBe(false);
    expect(effectiveNixSnapshot("garbage")).toBeNull();
  });

  test("a package's own commit wins over the org's; other managers get none", () => {
    expect(nixpkgsCommitFor("nix:jq", PIN, ORG)).toBe(PIN);
    expect(nixpkgsCommitFor("nix:jq", null, ORG)).toBe(ORG);
    expect(nixpkgsCommitFor("nix:jq", null, null)).toBeUndefined();
    expect(nixpkgsCommitFor("npm:prettier", null, ORG)).toBeUndefined();
  });
});
