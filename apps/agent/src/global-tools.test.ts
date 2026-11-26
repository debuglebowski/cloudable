import { describe, expect, test } from "bun:test";
import {
  OUTPUT_MARKER,
  afterMarker,
  cachedUserPackages,
  listGlobalTools,
  listUserPackages,
  parseCargoList,
  parseNixProfile,
  parseNpmGlobal,
  parsePipxList,
  runAsUser,
  versionFromStorePath,
} from "./global-tools";
import type { CommandRunner } from "./installed-packages";

describe("parsers", () => {
  test("npm: global packages with versions, minus npm and corepack themselves", () => {
    const out = JSON.stringify({
      dependencies: {
        npm: { version: "10.0.0" },
        corepack: {},
        "@openai/codex": { version: "0.5.0" },
        playwright: {},
      },
    });
    expect(parseNpmGlobal(out)).toEqual([
      { name: "@openai/codex", version: "0.5.0" },
      { name: "playwright" },
    ]);
  });

  test("pipx: venv names and the main package's version", () => {
    const out = JSON.stringify({
      venvs: {
        black: { metadata: { main_package: { package_version: "24.1.0" } } },
        ruff: {},
      },
    });
    expect(parsePipxList(out)).toEqual([{ name: "black", version: "24.1.0" }, { name: "ruff" }]);
  });

  test("cargo: crate lines with versions, not binary lines", () => {
    const out = "ripgrep v14.1.0:\n    rg\nfoo v0.1.0 (https://github.com/x/foo#abc):\n    foo\n";
    expect(parseCargoList(out)).toEqual([
      { name: "ripgrep", version: "14.1.0" },
      { name: "foo", version: "0.1.0" },
    ]);
  });

  test("garbage reads as nothing", () => {
    expect(parseNpmGlobal("not json")).toEqual([]);
    expect(parsePipxList("")).toEqual([]);
    expect(parseNixProfile("{")).toEqual([]);
  });
});

describe("Nix profile", () => {
  const rev = "a".repeat(40);
  const element = (attrPath: string, storePath: string) => ({
    active: true,
    attrPath,
    originalUrl: `github:NixOS/nixpkgs/${rev}`,
    outputs: null,
    priority: 5,
    storePaths: [storePath],
    url: `github:NixOS/nixpkgs/${rev}`,
  });

  test("the version is where Nix says the name ends", () => {
    expect(versionFromStorePath("/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ripgrep-14.1.0")).toBe(
      "14.1.0",
    );
    expect(
      versionFromStorePath("/nix/store/0123456789abcdfghijklmnpqrsvwxyz-python3.12-black-24.1.0"),
    ).toBe("24.1.0");
    expect(
      versionFromStorePath("/nix/store/0123456789abcdfghijklmnpqrsvwxyz-hello"),
    ).toBeUndefined();
    // A non-default output's name is not part of the version (seen on Nix 2.35 for curl).
    expect(
      versionFromStorePath("/nix/store/rjafg106f6sngkysyri204fsh4zvjjzk-curl-8.23.0-bin"),
    ).toBe("8.23.0");
  });

  test("Nix 2.18 (version 2): an array, removed by index", () => {
    const out = JSON.stringify({
      version: 2,
      elements: [
        element(
          "legacyPackages.x86_64-linux.ripgrep",
          "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ripgrep-14.1.0",
        ),
        element(
          "legacyPackages.aarch64-linux.python3Packages.black",
          "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-python3.12-black-24.1.0",
        ),
      ],
    });
    expect(parseNixProfile(out)).toMatchObject([
      { name: "ripgrep", version: "14.1.0", handle: "0" },
      { name: "python3Packages.black", version: "24.1.0", handle: "1" },
    ]);
  });

  test("Nix 2.20+ (version 3): keyed by name, removed by that name", () => {
    const out = JSON.stringify({
      version: 3,
      elements: {
        ripgrep: element(
          "legacyPackages.x86_64-linux.ripgrep",
          "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ripgrep-14.1.0",
        ),
      },
    });
    expect(parseNixProfile(out)).toMatchObject([
      { name: "ripgrep", version: "14.1.0", handle: "ripgrep" },
    ]);
  });

  test("elements with no nixpkgs attribute are left out", () => {
    const out = JSON.stringify({
      version: 2,
      elements: [
        { storePaths: ["/nix/store/0123456789abcdfghijklmnpqrsvwxyz-thing-1.0"] },
        element("", "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-x-1"),
        element(
          "legacyPackages.x86_64-linux.bad'name",
          "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-x-1",
        ),
      ],
    });
    expect(parseNixProfile(out)).toEqual([]);
  });
});

describe("runAsUser", () => {
  test("passes the command as arguments to a constant script, never splices it in", async () => {
    const calls: string[][] = [];
    await runAsUser(
      {
        run: async (binary, args) => {
          calls.push([binary, ...args]);
          return null;
        },
      },
      ["npm", "install", "-g", "$(rm -rf /)"],
      30,
      "someone",
    );
    expect(calls[0]).toEqual([
      "timeout",
      "30",
      "runuser",
      "-u",
      "someone",
      "--",
      "bash",
      "-lic",
      `cd "$HOME" 2>/dev/null || cd /; command -v "$1" >/dev/null 2>&1 || exit 127; printf '%s\\n' ${OUTPUT_MARKER}; exec "$@"`,
      "bash",
      "npm",
      "install",
      "-g",
      "$(rm -rf /)",
    ]);
  });
});

describe("output marker", () => {
  test("what the shell prints before the command is dropped; the command's output is kept", async () => {
    // Ubuntu's bash.bashrc prints this on stdout on every new machine, until the user has
    // used sudo once. It made `npm ls --json` unparseable and Ensure reinstall in a loop.
    const tip =
      'To run a command as administrator (user "root"), use "sudo <command>".\nSee "man sudo_root" for details.\n\n';
    const json = JSON.stringify({
      dependencies: { "@anthropic-ai/claude-code": { version: "2.1.332" } },
    });
    const runner: CommandRunner = {
      run: async () => ({ stdout: `${tip}${OUTPUT_MARKER}\n${json}\n`, exitCode: 0 }),
    };
    const result = await runAsUser(runner, ["npm", "ls", "-g", "--depth=0", "--json"], 20, "u");
    expect(result?.stdout).toBe(`${json}\n`);
    const packages = await listUserPackages(runner, "u");
    expect(packages.get("npm:@anthropic-ai/claude-code")).toBe("2.1.332");
  });

  test("output without a marker is left as it is", () => {
    expect(afterMarker("plain\n")).toBe("plain\n");
  });
});

describe("listUserPackages", () => {
  const runner = (calls: string[][]): CommandRunner => ({
    run: async (binary, args) => {
      calls.push([binary, ...args]);
      const command = args.slice(9).join(" ");
      if (command === "npm ls -g --depth=0 --json")
        return {
          stdout: JSON.stringify({ dependencies: { playwright: { version: "1.40.0" } } }),
          exitCode: 0,
        };
      if (command.startsWith("npm ls -g --prefix /usr"))
        return {
          stdout: JSON.stringify({ dependencies: { playwright: {}, yarn: {} } }),
          exitCode: 0,
        };
      if (command.startsWith("cargo")) return { stdout: "ripgrep v14.1.0:\n    rg\n", exitCode: 0 };
      if (command.startsWith("nix"))
        return {
          stdout: JSON.stringify({
            version: 2,
            elements: [
              {
                attrPath: "legacyPackages.x86_64-linux.jq",
                storePaths: ["/nix/store/0123456789abcdfghijklmnpqrsvwxyz-jq-1.7.1"],
              },
            ],
          }),
          exitCode: 0,
        };
      return { stdout: "", exitCode: 127 };
    },
  });

  test("prefixes each manager's packages, keeps versions, and runs as the machine user", async () => {
    const calls: string[][] = [];
    const packages = await listUserPackages(runner(calls), "someone");
    expect(Object.fromEntries(packages)).toEqual({
      "npm:playwright": "1.40.0",
      "npm:yarn": undefined,
      "cargo:ripgrep": "14.1.0",
      "nix:jq": "1.7.1",
    });
    for (const call of calls)
      expect(call.slice(0, 6)).toEqual(["timeout", "20", "runuser", "-u", "someone", "--"]);
  });

  test("listGlobalTools is the sorted names", async () => {
    expect(await listGlobalTools(runner([]), "someone")).toEqual([
      "cargo:ripgrep",
      "nix:jq",
      "npm:playwright",
      "npm:yarn",
    ]);
  });

  test("no managers at all reads as no packages", async () => {
    expect(await listGlobalTools({ run: async () => null })).toEqual([]);
  });
});

describe("cachedUserPackages", () => {
  test("asks again only after the interval, or after invalidate", async () => {
    let asked = 0;
    let clock = 0;
    const get = cachedUserPackages(
      1000,
      async () => new Map([[`npm:x${++asked}`, undefined]]),
      () => clock,
    );
    expect([...(await get()).keys()]).toEqual(["npm:x1"]);
    clock = 999;
    expect([...(await get()).keys()]).toEqual(["npm:x1"]);
    clock = 1000;
    expect([...(await get()).keys()]).toEqual(["npm:x2"]);
    get.invalidate();
    expect([...(await get()).keys()]).toEqual(["npm:x3"]);
  });
});
