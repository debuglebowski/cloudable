// ---------------------------------------------------------------------------
// PTY spawning for the web terminal (spec §11.1), via `Bun.Terminal` — a
// real, native, first-party PTY implementation (Bun 1.3.5+), not `node-pty`
// (confirmed broken under Bun, `oven-sh/bun#7362`). See docs/agents.md's
// "Tunnel daemon" section for the full empirical spike this decision is
// based on: basic I/O, resize, full-screen programs, and forced external
// termination (`Subprocess.kill()`, what `kill()` below calls) all confirmed
// working correctly on the real Linux production target; in-session
// keystroke-generated signals (Ctrl-C/Ctrl-Z) are a confirmed, documented
// limitation, not something this file works around.
//
// Real open gap, NOT solved here (flagged in the approved plan, not
// silently assumed safe): nothing today enforces `targetOsUser` at the OS
// level for this path the way the SSH path does via certificate
// `validPrincipals`. The daemon runs as root and drops privilege via
// `su - <targetOsUser>` — this needs its own security review before it
// ships (sudoers-style scoping, PAM session setup, etc. are all still
// open questions), not an assumption that a bare `su` call is sufficient.
// `spawnSession` below DOES validate `targetOsUser`'s shape before ever
// building the `su` argv (see `OS_USERNAME_PATTERN`) — that closes a
// specific argv-injection vector (a value like `"-c"` hijacking `su`'s own
// option parsing), not the OS-level-enforcement gap this paragraph is
// about. The two are different problems; only the first is addressed here.
// ---------------------------------------------------------------------------

/**
 * A conservative POSIX/Linux username shape — lowercase letters, digits, underscore, hyphen,
 * starting with a letter or underscore, capped at 32 chars (matches `useradd`'s own default
 * validation). Deliberately excludes anything a shell or `su` itself could interpret
 * specially — no leading `-`, no spaces, no shell metacharacters.
 *
 * This matters even though `targetOsUser` only ever reaches here after a signature
 * verification already passed (`session-manager.ts`'s `attach`): the signature proves the
 * CLAIM is genuinely what the control plane signed, not that the claim's VALUE is safe to
 * hand to `su`'s argv unexamined. A `targetOsUser` of e.g. `"-c"` would make
 * `["su", "-", "-c"]` — some `su` implementations parse a leading-dash argument in that
 * position as an OPTION, not a username, which could mean running an arbitrary command as
 * root (the daemon's own user) instead of dropping to anyone. Real privilege escalation, not
 * a theoretical one — this check exists specifically to close it, independent of whatever
 * validation the control plane does before ever signing the claim in the first place (see
 * `apps/control-plane/src/tunnel/server.ts`'s matching check on `mintSession`).
 */
const OS_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Exported for direct, deterministic testing — `spawnSession`'s own tests only get to
 * exercise the *rejection* path without a real `su`/root environment (a real accepted
 * username would attempt a real `su` call), so this is the one place that shape is checked
 * on its own, real usernames included. */
export function isValidOsUsername(value: string): boolean {
  return OS_USERNAME_PATTERN.test(value);
}

export class InvalidOsUserError extends Error {
  constructor(public readonly targetOsUser: string) {
    super(
      `refusing to spawn a session for an invalid OS username: ${JSON.stringify(targetOsUser)}`,
    );
    this.name = "InvalidOsUserError";
  }
}

export interface SpawnSessionOptions {
  targetOsUser: string;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
  onExit: (info: { exitCode: number | null; signalCode: string | null }) => void;
  /**
   * Test-only escape hatch: run this command instead of `su - <targetOsUser>`.
   * Never set in production code — the whole point of the real path is
   * dropping privilege into the claimed OS user; a test double doesn't need
   * (and typically can't, unprivileged) exercise that specific part.
   */
  commandOverride?: ReadonlyArray<string>;
}

export interface PtySession {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /**
   * Forcibly ends the session — confirmed reliable even though in-session
   * Ctrl-C is not (see file header). This is the mechanism policy-triggered
   * termination (`TunnelRelay.closeAllForMachine`, spec §8.2's "must
   * terminate live sessions on policy change") calls; it does not rely on
   * the PTY's line discipline at all.
   */
  kill(): void;
}

/** Spawns a real PTY-backed session for one terminal attach.
 *
 * @throws {InvalidOsUserError} if `targetOsUser` doesn't look like a real OS username and no
 * `commandOverride` was given to bypass the real `su` path — see `OS_USERNAME_PATTERN`'s doc
 * comment for why this check exists. Thrown before any PTY/process is created.
 */
export function spawnSession(options: SpawnSessionOptions): PtySession {
  if (!options.commandOverride && !isValidOsUsername(options.targetOsUser)) {
    throw new InvalidOsUserError(options.targetOsUser);
  }

  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    data: (_terminal, data) => options.onData(data),
  });

  const command = options.commandOverride ?? ["su", "-", options.targetOsUser];
  const proc = Bun.spawn([...command], { terminal });

  proc.exited.then((exitCode) => {
    options.onExit({ exitCode, signalCode: proc.signalCode ?? null });
    terminal.close();
  });

  return {
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    kill() {
      proc.kill();
    },
  };
}
