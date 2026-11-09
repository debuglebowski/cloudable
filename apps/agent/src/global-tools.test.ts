import { describe, expect, test } from "bun:test";
import {
  cachedGlobalTools,
  listGlobalTools,
  parseCargoList,
  parseNpmGlobal,
  parsePipxList,
} from "./global-tools";
import type { CommandRunner } from "./installed-packages";

describe("parsers", () => {
  test("npm: global packages, minus npm and corepack themselves", () => {
    const out = JSON.stringify({
      dependencies: { npm: {}, corepack: {}, "@openai/codex": {}, playwright: {} },
    });
    expect(parseNpmGlobal(out)).toEqual(["@openai/codex", "playwright"]);
  });

  test("pipx: venv names", () => {
    expect(parsePipxList(JSON.stringify({ venvs: { black: {}, ruff: {} } }))).toEqual([
      "black",
      "ruff",
    ]);
  });

  test("cargo: crate lines, not binary lines", () => {
    expect(parseCargoList("ripgrep v14.1.0:\n    rg\nbat v0.24.0:\n    bat\n")).toEqual([
      "ripgrep",
      "bat",
    ]);
  });

  test("garbage reads as nothing", () => {
    expect(parseNpmGlobal("not json")).toEqual([]);
    expect(parsePipxList("")).toEqual([]);
  });
});

describe("listGlobalTools", () => {
  test("prefixes each manager's tools and runs as the machine user", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: async (binary, args) => {
        calls.push([binary, ...args]);
        const script = args.at(-1) ?? "";
        if (script.includes("npm ls"))
          return { stdout: JSON.stringify({ dependencies: { playwright: {} } }), exitCode: 0 };
        if (script.includes("cargo")) return { stdout: "ripgrep v14.1.0:\n    rg\n", exitCode: 0 };
        return { stdout: "", exitCode: 1 };
      },
    };
    expect(await listGlobalTools(runner, "someone")).toEqual(["cargo:ripgrep", "npm:playwright"]);
    for (const call of calls)
      expect(call.slice(0, 5)).toEqual(["timeout", "20", "runuser", "-u", "someone"]);
  });

  test("no managers at all reads as no tools", async () => {
    expect(await listGlobalTools({ run: async () => null })).toEqual([]);
  });
});

describe("cachedGlobalTools", () => {
  test("asks again only after the interval", async () => {
    let asked = 0;
    let clock = 0;
    const get = cachedGlobalTools(
      1000,
      async () => [`npm:x${++asked}`],
      () => clock,
    );
    expect(await get()).toEqual(["npm:x1"]);
    clock = 999;
    expect(await get()).toEqual(["npm:x1"]);
    clock = 1000;
    expect(await get()).toEqual(["npm:x2"]);
  });
});
