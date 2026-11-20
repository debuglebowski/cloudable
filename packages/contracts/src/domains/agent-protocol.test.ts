import { describe, expect, test } from "bun:test";
import {
  isInstallablePackageName,
  isValidDeclaredPackageName,
  isValidVersionPin,
} from "./agent-protocol";

describe("nix package names", () => {
  test("nixpkgs attribute paths", () => {
    expect(isValidDeclaredPackageName("nix:ripgrep")).toBe(true);
    expect(isValidDeclaredPackageName("nix:python3Packages.black")).toBe(true);
    expect(isValidDeclaredPackageName("nix:gcc_13")).toBe(true);
  });

  test("anything that could be more than an attribute", () => {
    for (const name of [
      "nix:",
      "nix:.x",
      "nix:a..b",
      "nix:a#b",
      "nix:a b",
      "nix:1abc",
      "nix:a/b",
    ]) {
      expect(isValidDeclaredPackageName(name)).toBe(false);
    }
  });
});

describe("installable managers", () => {
  test("apt, npm, pipx, cargo and nix; never home", () => {
    for (const name of ["curl", "npm:prettier", "pipx:black", "cargo:ripgrep", "nix:jq"]) {
      expect(isInstallablePackageName(name)).toBe(true);
    }
    expect(isInstallablePackageName("home:chromium")).toBe(false);
  });
});

describe("version pins", () => {
  test("each manager's own version syntax", () => {
    expect(isValidVersionPin("curl", "7.81.0-1ubuntu1.16")).toBe(true);
    expect(isValidVersionPin("curl", "1:2.3~rc1")).toBe(true);
    expect(isValidVersionPin("npm:prettier", "^3.3.0")).toBe(true);
    expect(isValidVersionPin("pipx:black", "24.1.0")).toBe(true);
    expect(isValidVersionPin("cargo:ripgrep", "14.1.0")).toBe(true);
    expect(isValidVersionPin("nix:jq", "0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  test("never shell syntax, and a Nix pin is only ever a commit", () => {
    expect(isValidVersionPin("npm:prettier", "3; rm -rf /")).toBe(false);
    expect(isValidVersionPin("cargo:ripgrep", "$(id)")).toBe(false);
    expect(isValidVersionPin("nix:jq", "nixos-unstable")).toBe(false);
    expect(isValidVersionPin("nix:jq", "0123456789ABCDEF0123456789abcdef01234567")).toBe(false);
    expect(isValidVersionPin("home:chromium", "1.0")).toBe(false);
    expect(isValidVersionPin("curl", "")).toBe(false);
  });
});
