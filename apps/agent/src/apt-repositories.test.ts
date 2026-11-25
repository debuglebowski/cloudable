import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AptRepositoryConfig } from "@cloudable/contracts";
import {
  applyAptRepositories,
  aptRepositoriesFrom,
  parseDeb822Sources,
  parseOneLineSources,
  readAptRepositoryIds,
  readAptSources,
  sourcesFileFor,
} from "./apt-repositories";
import type { CommandResult, CommandRunner } from "./installed-packages";

const KEY = [
  "-----BEGIN PGP PUBLIC KEY BLOCK-----",
  "",
  "mQINBGTestKeyDataOnly",
  "=abcd",
  "-----END PGP PUBLIC KEY BLOCK-----",
].join("\n");

const ID_A = "0b6f2a3e-8c1d-4e5f-9a7b-1c2d3e4f5a6b";
const ID_B = "1c7a3b4f-9d2e-4f60-8b8c-2d3e4f5a6b7c";

const repo = (overrides: Partial<AptRepositoryConfig> = {}): AptRepositoryConfig => ({
  id: ID_A,
  url: "https://deb.nodesource.com/node_24.x",
  suite: "nodistro",
  components: ["main"],
  signingKey: KEY,
  fingerprint: "6F71F525282841EEDAF851B42F59B5F99B1BE0B4",
  ...overrides,
});

function recordingRunner(
  result: CommandResult | null = { stdout: "", exitCode: 0 },
): CommandRunner & { calls: Array<{ binary: string; args: readonly string[] }> } {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  return {
    calls,
    async run(binary, args) {
      calls.push({ binary, args });
      return result;
    },
  };
}

const silent = () => {};

let aptDir: string;

beforeEach(() => {
  aptDir = mkdtempSync(join(tmpdir(), "cloudable-apt-"));
  mkdirSync(join(aptDir, "sources.list.d"));
});

afterEach(() => {
  rmSync(aptDir, { recursive: true, force: true });
});

const sourcesPath = (id: string) => join(aptDir, "sources.list.d", `cloudable-${id}.sources`);
const keyPath = (id: string) => join(aptDir, "keyrings", `cloudable-${id}.asc`);

describe("applyAptRepositories", () => {
  test("writes the key and a deb822 sources file, then runs apt-get update once", async () => {
    const runner = recordingRunner();

    const result = await applyAptRepositories([repo()], { aptDir, runner, log: silent });

    expect(result).toEqual({ changed: 2, updateFailed: false });
    expect(readFileSync(keyPath(ID_A), "utf-8")).toBe(`${KEY}\n`);
    const sources = readFileSync(sourcesPath(ID_A), "utf-8");
    expect(sources).toContain("Types: deb\n");
    expect(sources).toContain("URIs: https://deb.nodesource.com/node_24.x\n");
    expect(sources).toContain("Suites: nodistro\n");
    expect(sources).toContain("Components: main\n");
    expect(sources).toContain(`Signed-By: ${keyPath(ID_A)}\n`);
    expect(statSync(sourcesPath(ID_A)).mode & 0o777).toBe(0o644);
    expect(statSync(keyPath(ID_A)).mode & 0o777).toBe(0o644);
    expect(runner.calls).toEqual([{ binary: "apt-get", args: ["update"] }]);
  });

  test("joins several components with spaces", () => {
    expect(sourcesFileFor(repo({ components: ["main", "contrib"] }), "/etc/apt")).toContain(
      "Components: main contrib\n",
    );
  });

  test("does nothing, and runs no apt-get update, when the files already match", async () => {
    await applyAptRepositories([repo()], { aptDir, runner: recordingRunner(), log: silent });
    const runner = recordingRunner();

    const result = await applyAptRepositories([repo()], { aptDir, runner, log: silent });

    expect(result).toEqual({ changed: 0, updateFailed: false });
    expect(runner.calls).toEqual([]);
  });

  test("rewrites a file someone edited", async () => {
    await applyAptRepositories([repo()], { aptDir, runner: recordingRunner(), log: silent });
    writeFileSync(sourcesPath(ID_A), "Types: deb\nURIs: https://evil.example\n");
    const runner = recordingRunner();

    const result = await applyAptRepositories([repo()], { aptDir, runner, log: silent });

    expect(result.changed).toBe(1);
    expect(readFileSync(sourcesPath(ID_A), "utf-8")).toBe(sourcesFileFor(repo(), aptDir));
    expect(runner.calls).toHaveLength(1);
  });

  test("removes stale cloudable files and leaves every other file alone", async () => {
    await applyAptRepositories([repo(), repo({ id: ID_B })], {
      aptDir,
      runner: recordingRunner(),
      log: silent,
    });
    const foreignList = join(aptDir, "sources.list.d", "nodesource.list");
    const foreignSources = join(aptDir, "sources.list.d", "ubuntu.sources");
    const foreignKey = join(aptDir, "keyrings", "nodesource.gpg");
    const lookalike = join(aptDir, "sources.list.d", "my-cloudable-x.sources");
    for (const path of [foreignList, foreignSources, foreignKey, lookalike]) {
      writeFileSync(path, "keep me\n");
    }
    const runner = recordingRunner();

    const result = await applyAptRepositories([repo({ id: ID_B })], {
      aptDir,
      runner,
      log: silent,
    });

    expect(result.changed).toBe(2);
    expect(existsSync(sourcesPath(ID_A))).toBe(false);
    expect(existsSync(keyPath(ID_A))).toBe(false);
    expect(existsSync(sourcesPath(ID_B))).toBe(true);
    expect(existsSync(keyPath(ID_B))).toBe(true);
    for (const path of [foreignList, foreignSources, foreignKey, lookalike]) {
      expect(readFileSync(path, "utf-8")).toBe("keep me\n");
    }
    expect(runner.calls).toEqual([{ binary: "apt-get", args: ["update"] }]);
  });

  test("an empty list removes every cloudable file", async () => {
    await applyAptRepositories([repo()], { aptDir, runner: recordingRunner(), log: silent });

    const result = await applyAptRepositories([], {
      aptDir,
      runner: recordingRunner(),
      log: silent,
    });

    expect(result.changed).toBe(2);
    expect(readAptRepositoryIds(aptDir)).toEqual([]);
  });

  test("a failed apt-get update is reported, not thrown, and forceUpdate runs it again", async () => {
    const failing = recordingRunner({ stdout: "", stderr: "E: offline", exitCode: 100 });
    const first = await applyAptRepositories([repo()], { aptDir, runner: failing, log: silent });
    expect(first.updateFailed).toBe(true);

    const runner = recordingRunner();
    const second = await applyAptRepositories([repo()], {
      aptDir,
      runner,
      forceUpdate: true,
      log: silent,
    });

    expect(second).toEqual({ changed: 0, updateFailed: false });
    expect(runner.calls).toEqual([{ binary: "apt-get", args: ["update"] }]);
  });
});

describe("aptRepositoriesFrom", () => {
  const from = (value: unknown) => aptRepositoriesFrom({ aptRepositories: value }, silent);

  test("absent, or not a list, means none", () => {
    expect(aptRepositoriesFrom({}, silent)).toEqual([]);
    expect(aptRepositoriesFrom(undefined, silent)).toEqual([]);
    expect(from("nope")).toEqual([]);
  });

  test("keeps a valid entry", () => {
    expect(from([repo()])).toEqual([repo()]);
  });

  test("accepts a flat repository with no components", () => {
    expect(from([repo({ suite: "stable/", components: [] })])).toHaveLength(1);
  });

  const invalid: Array<[string, unknown]> = [
    ["not an object", "x"],
    ["id is not a UUID", repo({ id: "../../etc/passwd" })],
    ["http url", repo({ url: "http://deb.example.com" })],
    ["url with a newline", repo({ url: "https://a.example\nTypes: deb-src" })],
    ["url with a space", repo({ url: "https://a.example /x" })],
    ["bad suite", repo({ suite: "noble\nURIs: https://evil" })],
    ["bad component", repo({ components: ["main", "x y"] })],
    ["no components", repo({ components: [] })],
    ["components on a flat repository", repo({ suite: "stable/" })],
    ["key without armor", repo({ signingKey: "not a key" })],
    ["private key", repo({ signingKey: KEY.replaceAll("PUBLIC", "PRIVATE") })],
    ["two armor blocks", repo({ signingKey: `${KEY}\n${KEY}` })],
    ["non-ASCII key", repo({ signingKey: KEY.replace("=abcd", "=ab\u0000d") })],
  ];
  for (const [name, entry] of invalid) {
    test(`skips an invalid entry: ${name}`, () => {
      const logged: string[] = [];
      expect(
        aptRepositoriesFrom({ aptRepositories: [entry, repo({ id: ID_B })] }, (m) =>
          logged.push(m),
        ),
      ).toEqual([repo({ id: ID_B })]);
      expect(logged).toHaveLength(1);
    });
  }

  test("skips a repeated id", () => {
    expect(from([repo(), repo({ url: "https://other.example" })])).toEqual([repo()]);
  });
});

describe("report", () => {
  test("parses one-line sources, skipping comments, blanks and deb-src", () => {
    const text = [
      "# a comment",
      "",
      "deb http://archive.ubuntu.com/ubuntu noble main restricted",
      "deb-src http://archive.ubuntu.com/ubuntu noble main",
      "deb [arch=amd64 signed-by=/etc/apt/keyrings/x.gpg] https://download.docker.com/linux/ubuntu noble stable",
      "  deb https://indented.example/ noble main # trailing comment",
      "# deb https://commented.example/ noble main",
    ].join("\n");

    expect(parseOneLineSources(text)).toEqual([
      "http://archive.ubuntu.com/ubuntu",
      "https://download.docker.com/linux/ubuntu",
      "https://indented.example/",
    ]);
  });

  test("parses deb822 stanzas: several URIs, Enabled: no, deb-src only, inline keys", () => {
    const text = [
      "# Ubuntu sources",
      "Types: deb",
      "URIs: http://archive.ubuntu.com/ubuntu/ http://mirror.example/ubuntu/",
      "Suites: noble noble-updates",
      "Components: main",
      "",
      "Types: deb",
      "URIs: https://disabled.example/",
      "Suites: noble",
      "Components: main",
      "Enabled: no",
      "",
      "Types: deb-src",
      "URIs: https://src-only.example/",
      "Suites: noble",
      "Components: main",
      "",
      "types: deb deb-src",
      "uris:",
      " https://folded.example/",
      "suites: noble",
      "components: main",
      "Signed-By:",
      " -----BEGIN PGP PUBLIC KEY BLOCK-----",
      " .",
      " https://not-a-uri.example/",
      " -----END PGP PUBLIC KEY BLOCK-----",
    ].join("\n");

    expect(parseDeb822Sources(text)).toEqual([
      "http://archive.ubuntu.com/ubuntu/",
      "http://mirror.example/ubuntu/",
      "https://folded.example/",
    ]);
  });

  test("reads every source file apt reads, one entry per file and URI", async () => {
    writeFileSync(
      join(aptDir, "sources.list"),
      "deb http://archive.ubuntu.com/ubuntu noble main\ndeb http://archive.ubuntu.com/ubuntu noble-updates main\n",
    );
    writeFileSync(
      join(aptDir, "sources.list.d", "nodesource.list"),
      "deb https://deb.nodesource.com/node_20.x nodistro main\n",
    );
    writeFileSync(join(aptDir, "sources.list.d", "ignored.list.save"), "deb https://x/ a b\n");
    await applyAptRepositories([repo()], { aptDir, runner: recordingRunner(), log: silent });

    expect(readAptSources(aptDir)).toEqual([
      { file: join(aptDir, "sources.list"), uri: "http://archive.ubuntu.com/ubuntu" },
      { file: sourcesPath(ID_A), uri: "https://deb.nodesource.com/node_24.x" },
      {
        file: join(aptDir, "sources.list.d", "nodesource.list"),
        uri: "https://deb.nodesource.com/node_20.x",
      },
    ]);
  });

  test("reports an approved repository only when both its files exist", async () => {
    await applyAptRepositories([repo(), repo({ id: ID_B })], {
      aptDir,
      runner: recordingRunner(),
      log: silent,
    });
    rmSync(keyPath(ID_B));

    expect(readAptRepositoryIds(aptDir)).toEqual([ID_A]);
  });

  test("no apt directory reports nothing", () => {
    expect(readAptSources(join(aptDir, "missing"))).toEqual([]);
    expect(readAptRepositoryIds(join(aptDir, "missing"))).toEqual([]);
  });
});
