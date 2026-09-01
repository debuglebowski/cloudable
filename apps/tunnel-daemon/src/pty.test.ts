import { describe, expect, test } from "bun:test";
import { InvalidOsUserError, isValidOsUsername, spawnSession } from "./pty";

// `commandOverride` is used throughout instead of a real `su - <user>` — these tests run
// unprivileged and are exercising `Bun.Terminal`'s real PTY behavior, not the privilege-drop
// step (a real open gap, documented in pty.ts's header, not something these tests claim to cover).

const waitFor = (predicate: () => boolean, timeoutMs = 5_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error("timed out waiting for condition"));
      setTimeout(check, 20);
    };
    check();
  });

describe("spawnSession (real Bun.Terminal PTY)", () => {
  test("basic I/O: writing to the session echoes back through onData", async () => {
    let output = "";
    const session = spawnSession({
      targetOsUser: "unused",
      cols: 80,
      rows: 24,
      commandOverride: ["sh"],
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
      onExit: () => {},
    });

    session.write("echo PTY_TEST_OK\n");
    await waitFor(() => output.includes("PTY_TEST_OK"));
    expect(output).toContain("PTY_TEST_OK");

    session.kill();
  });

  test("resize actually changes the PTY's real termios-level size (stty size)", async () => {
    let output = "";
    const session = spawnSession({
      targetOsUser: "unused",
      cols: 80,
      rows: 24,
      commandOverride: ["sh"],
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
      onExit: () => {},
    });

    session.resize(120, 40);
    session.write("stty size\n");
    // `stty size` prints "<rows> <cols>".
    await waitFor(() => output.includes("40 120"));
    expect(output).toContain("40 120");

    session.kill();
  });

  test("kill() forcibly terminates a running session — the mechanism policy-triggered termination depends on", async () => {
    let exitInfo: { exitCode: number | null; signalCode: string | null } | undefined;
    const session = spawnSession({
      targetOsUser: "unused",
      cols: 80,
      rows: 24,
      commandOverride: ["sleep", "100"],
      onData: () => {},
      onExit: (info) => {
        exitInfo = info;
      },
    });

    session.kill();
    await waitFor(() => exitInfo !== undefined, 10_000);
    expect(exitInfo).toBeDefined();
    // A killed process never reports a clean `exitCode: 0` — either a nonzero code or a
    // recorded signal, never "as if it exited normally on its own".
    expect(exitInfo?.exitCode === 0 && exitInfo?.signalCode === null).toBe(false);
  });
});

describe("isValidOsUsername", () => {
  test("accepts real-looking usernames", () => {
    for (const value of [
      "ubuntu",
      "root",
      "deploy-bot",
      "svc_1",
      "_reserved",
      "a",
      "x".repeat(32),
    ]) {
      expect(isValidOsUsername(value)).toBe(true);
    }
  });

  // REQUIRED FAILURE PATH — this is the actual security property: a value that could hijack
  // `su`'s own argument parsing (see pty.ts's `OS_USERNAME_PATTERN` doc comment for the real
  // privilege-escalation scenario this closes) must never pass.
  test("REQUIRED FAILURE PATH: rejects values that could be interpreted as su options or shell syntax", () => {
    for (const value of [
      "-c",
      "--command=whoami",
      "-",
      "root; rm -rf /",
      "root && whoami",
      "with space",
      "",
      "x".repeat(33), // one over the length cap
      "Root", // uppercase — outside the accepted shape
      "1root", // must start with a letter or underscore, not a digit
    ]) {
      expect(isValidOsUsername(value)).toBe(false);
    }
  });
});

describe("spawnSession: targetOsUser validation", () => {
  test("throws InvalidOsUserError for a malicious-shaped targetOsUser, without commandOverride, before spawning anything", () => {
    expect(() =>
      spawnSession({
        targetOsUser: "-c",
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: () => {},
      }),
    ).toThrow(InvalidOsUserError);
  });

  test("commandOverride bypasses the targetOsUser check entirely (the documented test-only escape hatch)", () => {
    const session = spawnSession({
      targetOsUser: "-c", // would be rejected without commandOverride
      cols: 80,
      rows: 24,
      commandOverride: ["sh"],
      onData: () => {},
      onExit: () => {},
    });
    session.kill();
  });
});
