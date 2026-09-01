import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "./installed-packages";
import { listInstalledPackages } from "./installed-packages";

/** A fake `CommandRunner` keyed by binary name — `undefined` means "not present"
 * (mirrors `bunCommandRunner` returning `null` on ENOENT). */
function fakeRunner(responses: Record<string, CommandResult | undefined>): CommandRunner {
  return {
    run: async (binary) => responses[binary] ?? null,
  };
}

describe("listInstalledPackages", () => {
  test("parses dpkg-query output into bare package names", async () => {
    const runner = fakeRunner({
      "dpkg-query": { stdout: "docker\ncurl\nnodejs\n", exitCode: 0 },
    });
    expect(await listInstalledPackages(runner)).toEqual(["docker", "curl", "nodejs"]);
  });

  test("falls back to rpm when dpkg-query isn't present", async () => {
    const runner = fakeRunner({
      rpm: { stdout: "curl\nvim\n", exitCode: 0 },
    });
    expect(await listInstalledPackages(runner)).toEqual(["curl", "vim"]);
  });

  test("falls back to rpm when dpkg-query is present but exits non-zero", async () => {
    const runner = fakeRunner({
      "dpkg-query": { stdout: "", exitCode: 2 },
      rpm: { stdout: "curl\n", exitCode: 0 },
    });
    expect(await listInstalledPackages(runner)).toEqual(["curl"]);
  });

  test("returns [] when neither package manager is present", async () => {
    const runner = fakeRunner({});
    expect(await listInstalledPackages(runner)).toEqual([]);
  });

  test("dedupes repeated package names", async () => {
    const runner = fakeRunner({
      "dpkg-query": { stdout: "docker\ndocker\ncurl\n", exitCode: 0 },
    });
    expect(await listInstalledPackages(runner)).toEqual(["docker", "curl"]);
  });

  test("strips blank lines and surrounding whitespace", async () => {
    const runner = fakeRunner({
      "dpkg-query": { stdout: "docker\n\n  curl  \n\n", exitCode: 0 },
    });
    expect(await listInstalledPackages(runner)).toEqual(["docker", "curl"]);
  });
});
