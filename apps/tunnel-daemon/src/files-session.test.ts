import { describe, expect, test } from "bun:test";

import { fsHelperCommand, spawnFilesSession } from "./files-session";
import { InvalidOsUserError } from "./pty";

/**
 * The real path drops privilege with `su`, which needs root, so these tests cover the two
 * things that CAN be checked unprivileged: the argv that would be handed to `su`, and the
 * refusal that happens before any process is created. Same split `pty.test.ts` uses, for
 * the same reason.
 */
describe("fsHelperCommand", () => {
  test("drops into the target user and re-execs this binary as the helper", () => {
    expect(fsHelperCommand("cloudable", "/usr/local/bin/cloudable-tunnel-daemon")).toEqual([
      "su",
      "-",
      "cloudable",
      "-c",
      "'/usr/local/bin/cloudable-tunnel-daemon' --fs-helper",
    ]);
  });

  test("the username is its own argv element and never reaches su's shell", () => {
    const argv = fsHelperCommand("cloudable", "/usr/local/bin/d");
    expect(argv[2]).toBe("cloudable");
    expect(argv[4]).not.toContain("cloudable\n");
  });

  test("quotes the binary path, which su -c does hand to a shell", () => {
    // Not reachable by a caller — the path is `process.execPath`, not input — but the
    // quoting is what makes that true rather than incidental.
    const argv = fsHelperCommand("cloudable", "/opt/my daemon/bin");
    expect(argv[4]).toBe("'/opt/my daemon/bin' --fs-helper");
  });

  test("escapes a single quote in the path rather than ending the quoted string", () => {
    const argv = fsHelperCommand("cloudable", "/opt/it's/bin");
    expect(argv[4]).toBe("'/opt/it'\\''s/bin' --fs-helper");
  });
});

describe("spawnFilesSession", () => {
  // `su` parses a leading-dash argument in the username position as an OPTION in some
  // implementations, which would run a command as root — the daemon's own user — instead
  // of dropping to anybody. `pty.ts` documents the vector at length; the same check has
  // to guard the same vector on this path, or the file interface becomes the way around it.
  test.each(["-c", "root user", "Root", "", "a".repeat(33), "1abc"])(
    "REQUIRED FAILURE PATH: refuses the malformed username %p before spawning anything",
    (osUser) => {
      expect(() =>
        spawnFilesSession({
          targetOsUser: osUser,
          onResult: () => {},
          onChunk: () => {},
          onExit: () => {},
        }),
      ).toThrow(InvalidOsUserError);
    },
  );

  test("accepts a well-formed username (exercised through a harmless commandOverride)", () => {
    const session = spawnFilesSession({
      targetOsUser: "cloudable",
      commandOverride: ["cat"],
      onResult: () => {},
      onChunk: () => {},
      onExit: () => {},
    });
    expect(typeof session.request).toBe("function");
    session.kill();
  });
});
