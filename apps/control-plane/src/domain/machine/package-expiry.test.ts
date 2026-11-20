import { describe, expect, test } from "bun:test";
import { type ActionRow, actionExpiryMs, expiredActionIds } from "./package-actions";

const MIN = 60 * 1000;
const START = new Date("2026-11-20T10:00:00Z");

const row = (id: string, packageName: string, requestedOffsetMin: number): ActionRow =>
  ({
    id,
    packageName,
    status: "running",
    startedAt: START,
    requestedAt: new Date(START.getTime() - 60 * MIN + requestedOffsetMin * MIN),
  }) as ActionRow;

describe("action expiry", () => {
  test("per manager: cargo and nix get longer than apt", () => {
    expect(actionExpiryMs("curl")).toBe(5 * MIN);
    expect(actionExpiryMs("npm:prettier")).toBe(15 * MIN);
    expect(actionExpiryMs("cargo:ripgrep")).toBe(35 * MIN);
    expect(actionExpiryMs("nix:jq")).toBe(35 * MIN);
  });

  test("an apt install queued behind a cargo build waits for it", () => {
    const rows = [row("cargo", "cargo:ripgrep", 0), row("apt", "curl", 1)];
    // 20 minutes in: past apt's own five, but inside cargo's 35 plus apt's 5.
    expect(expiredActionIds(rows, new Date(START.getTime() + 20 * MIN))).toEqual([]);
    expect(expiredActionIds(rows, new Date(START.getTime() + 36 * MIN))).toEqual(["cargo"]);
    expect(expiredActionIds(rows, new Date(START.getTime() + 41 * MIN))).toEqual(["cargo", "apt"]);
  });

  test("a lone apt install still expires after five minutes", () => {
    expect(expiredActionIds([row("apt", "curl", 0)], new Date(START.getTime() + 6 * MIN))).toEqual([
      "apt",
    ]);
  });
});
