// ---------------------------------------------------------------------------
// Tunnel client: PTY + WebSocket transport for interactive sessions (web
// terminal / SSH — spec §8.2/§11.1). This is the agent-side counterpart to
// `apps/control-plane/src/tunnel/session-token.ts` — see docs/access.md §3/§4.
//
// SCOPE OF THIS UNIT: docs/access.md §4 documents that the actual
// reverse-tunnel network transport (an outbound connection from a machine
// that carries interactive session bytes) does not exist yet anywhere in
// this build — "wiring an actual tunnel daemon process into apps/agent and a
// byte-relay protocol is future work for whichever unit builds the agent's
// tunnel half." This file is that work. There is no `packages/contracts`
// wire-type entry for this yet either, so the message shape below
// (`TunnelWireMessage`) is this unit's own minimal design, not a shared
// contract — a future unit wiring the real control-plane endpoint this
// connects to should feel free to revise it.
//
// WHAT THIS DOES:
//   1. Opens ONE outbound WebSocket (agent is always the client — CLAUDE.md
//      invariant #7, no inbound access to any machine, ever).
//   2. On connect, verifies the session token LOCALLY — via a temporary stub,
//      see `_temp-verify-stub.ts` — before doing anything else. A failed
//      verification closes the socket immediately; no PTY is ever spawned
//      (docs/spec.md §11.1: "trusting the tunnel because it is already
//      authenticated makes a control plane compromise equal to root on every
//      machine in the fleet" — this is why verification happens first, not
//      after).
//   3. On success, spawns a PTY-backed shell (`Bun.Terminal`, see below) and
//      relays bytes bidirectionally between the socket and the process.
//   4. Handles `{"type":"terminate"}` by killing the process and closing the
//      socket.
//
// PTY MECHANISM: `Bun.Terminal` (`Bun.spawn({ terminal: {...} })`), shipped
// natively in this repo's pinned Bun version (1.3.6) — confirmed available
// (`typeof Bun.Terminal === "function"`) and typed in this repo's installed
// `@types/bun`. This is a REAL PTY (termios-level), not a line-buffered
// pipe — see this unit's PR description for what was and wasn't verified
// manually. `spawnPty` is injected (defaulting to `spawnRealPty`) so tests
// can substitute a fast, deterministic fake without spawning real OS
// processes; `client.test.ts` also runs at least one relay test through the
// real default.
// ---------------------------------------------------------------------------
import { type BackoffOptions, DEFAULT_BACKOFF, fullJitterBackoffMs } from "../backoff";
// One-line swap once the sibling unit's real module lands — see that file's banner.
import { verifySessionTokenLocally as verifySessionToken } from "./_temp-verify-stub";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This unit's own minimal wire envelope (no shared contract exists for this
 * yet — see file banner). `data` carries base64-encoded raw bytes in either
 * direction; `resize`/`terminate` are control messages; `exited` reports the
 * child process ending on its own (as opposed to being killed by
 * `terminate`).
 */
export type TunnelWireMessage =
  | { type: "data"; dataBase64: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "terminate" }
  | { type: "exited"; exitCode: number };

export interface PtySpawnCallbacks {
  readonly onData: (data: Uint8Array) => void;
  readonly onExit: (exitCode: number) => void;
}

export interface PtyHandle {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Kills the underlying process and releases the PTY. Idempotent. */
  kill(): void;
}

export type SpawnPty = (cols: number, rows: number, callbacks: PtySpawnCallbacks) => PtyHandle;

/**
 * Real PTY via `Bun.Terminal`. POSIX-only per Bun's own docs — a non-issue
 * in production (Cloudable machines are always Linux, per CLAUDE.md's
 * stack), so the failure mode below should be unreachable outside an
 * unusual dev host.
 *
 * Per-OS-user execution (running the shell as `claims.targetOsUser` rather
 * than whatever user this process runs as) is NOT implemented — a known,
 * deliberate gap for this unit, flagged in the PR description rather than
 * silently degraded. `claims.targetOsUser`/`claims.method` are available at
 * the call site (see `verifySessionToken`'s result in `connectAndRelay`) for
 * whichever unit adds that.
 */
export const spawnRealPty: SpawnPty = (cols, rows, callbacks) => {
  const shell = process.env.SHELL ?? "/bin/sh";
  const proc = Bun.spawn({
    cmd: [shell],
    terminal: {
      cols,
      rows,
      data: (_terminal, data) => callbacks.onData(data),
      exit: (_terminal, exitCode) => callbacks.onExit(exitCode),
    },
  });

  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill();
    throw new Error("Bun.Terminal unavailable on this platform (POSIX only)");
  }

  return {
    write: (data) => {
      terminal.write(data);
    },
    resize: (newCols, newRows) => {
      terminal.resize(newCols, newRows);
    },
    kill: () => {
      try {
        terminal.close();
      } catch {
        // already closed — fine, kill() is idempotent.
      }
      try {
        proc.kill();
      } catch {
        // already dead — fine.
      }
    },
  };
};

export interface TunnelSessionOptions {
  /** Outbound WebSocket URL to connect to. Agent-initiated only (invariant #7). */
  readonly url: string;
  /** The signed session token minted by `POST /api/v1/access/sessions`, verified locally
   * before any PTY is spawned. */
  readonly sessionToken: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly signal?: AbortSignal;
  /** Injection point for tests — defaults to `spawnRealPty`. */
  readonly spawnPty?: SpawnPty;
  readonly backoff?: BackoffOptions;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function decodeMessageText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  return undefined;
}

/**
 * One connection attempt, spanning the session's lifetime until it ends —
 * cleanly (`terminate`, the process exiting on its own, or an abort signal)
 * or unexpectedly (the socket dropping). Never throws: every failure path
 * resolves `false` so the caller's reconnect loop can back off and retry.
 *
 * Resolves `true` when the session is over for good (retrying would be
 * pointless or wrong — a rejected token, an explicit `terminate`, the
 * process exiting, or the caller aborting), `false` when the connection was
 * lost unexpectedly and the caller should reconnect.
 */
function connectAndRelay(
  options: Required<Pick<TunnelSessionOptions, "url" | "sessionToken" | "spawnPty">> &
    Pick<TunnelSessionOptions, "cols" | "rows" | "signal">,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    let settled = false;
    let pty: PtyHandle | undefined;

    const ws = new WebSocket(options.url);

    const finish = (terminatedForGood: boolean) => {
      if (settled) return;
      settled = true;
      pty?.kill();
      try {
        ws.close();
      } catch {
        // already closed/closing — fine.
      }
      resolve(terminatedForGood);
    };

    const send = (message: TunnelWireMessage) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // socket already closing/closed — nothing left to relay to.
      }
    };

    ws.addEventListener("open", () => {
      verifySessionToken(options.sessionToken).then(
        (claims) => {
          console.log(
            `tunnel: session token verified (machine=${claims.targetMachineId}, identity=${claims.idpIdentity}) — spawning PTY`,
          );
          // Deliberately NOT inside the same try/catch as verification: a `spawnPty` failure
          // here is a local infra problem (e.g. the shell binary is missing), not a rejected
          // token — keeping the two apart means the log line a human sees actually matches
          // what went wrong, and this is still the correct "close, don't spawn twice" outcome
          // for both.
          try {
            pty = options.spawnPty(cols, rows, {
              onData: (data) => send({ type: "data", dataBase64: toBase64(data) }),
              onExit: (exitCode) => {
                send({ type: "exited", exitCode });
                // Defer the actual teardown by one macrotask: `finish` closes the socket, and
                // closing immediately after `send()` can race the underlying write before it
                // flushes — this gives the "exited" notification a real chance to reach the
                // other side before the connection goes away.
                setTimeout(() => finish(true), 0);
              },
            });
          } catch (error) {
            console.error(`tunnel: failed to spawn PTY, closing: ${String(error)}`);
            finish(false); // a local spawn failure may well be transient — retry.
          }
        },
        (error) => {
          // Verification failed — close immediately. No PTY has been (or ever will be, for
          // this connection) spawned. Not retried: a rejected token doesn't become valid on
          // reconnect (same reasoning as `AttestationRejectedError` in poll-report-loop.ts).
          console.error(
            `tunnel: session token verification failed, refusing to attach: ${String(error)}`,
          );
          finish(true);
        },
      );
    });

    ws.addEventListener("message", (event) => {
      // Nothing to relay to until verification succeeds and the PTY exists — messages that
      // arrive in that (normally very short) window are dropped rather than buffered.
      if (!pty) return;

      const text = decodeMessageText((event as { data: unknown }).data);
      if (text === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const type = (parsed as { type?: unknown }).type;

      // Guarded: the PTY can die (process exits) in the gap between the `if (!pty) return`
      // check above and here, since `onExit` fires asynchronously — a write/resize racing
      // that should never crash the socket's message loop.
      try {
        if (type === "data") {
          const dataBase64 = (parsed as { dataBase64?: unknown }).dataBase64;
          if (typeof dataBase64 === "string") pty.write(fromBase64(dataBase64));
        } else if (type === "resize") {
          const newCols = (parsed as { cols?: unknown }).cols;
          const newRows = (parsed as { rows?: unknown }).rows;
          if (typeof newCols === "number" && typeof newRows === "number") {
            pty.resize(newCols, newRows);
          }
        } else if (type === "terminate") {
          finish(true);
        }
      } catch (error) {
        console.error(`tunnel: error relaying to PTY: ${String(error)}`);
      }
    });

    ws.addEventListener("close", () => {
      // If we already called `finish`, this is the close we ourselves triggered — expected,
      // not a failure. Otherwise the socket dropped out from under us; the caller should retry.
      if (!settled) finish(false);
    });
    ws.addEventListener("error", () => {
      if (!settled) finish(false);
    });

    options.signal?.addEventListener("abort", () => finish(true));
  });
}

/**
 * Maintains a tunnel session for its full lifetime, reconnecting with full-jitter backoff
 * (see `backoff.ts`) if the connection drops unexpectedly — modeled on `poll-report-loop.ts`'s
 * `for(;;)` + `AbortSignal` shape, not a different pattern. Returns once the session has ended
 * for good (clean termination, the process exiting, a rejected token, or an aborted signal).
 */
export async function runTunnelSession(options: TunnelSessionOptions): Promise<void> {
  const spawnPty = options.spawnPty ?? spawnRealPty;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let attempt = 0;

  for (;;) {
    if (options.signal?.aborted) return;

    const terminatedForGood = await connectAndRelay({ ...options, spawnPty });
    if (terminatedForGood) return;
    if (options.signal?.aborted) return;

    const delay = fullJitterBackoffMs(attempt, backoff);
    attempt += 1;
    console.log(
      `tunnel: connection lost, reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`,
    );
    await sleep(delay);
  }
}

/**
 * Manual "attach now" trigger for this unit (a separate sibling unit owns real CP→agent
 * signaling — see this unit's PR description). Reads `TUNNEL_ATTACH_URL` and
 * `TUNNEL_SESSION_TOKEN` directly from the environment — deliberately NOT added to `config.ts`'s
 * shared object, since these aren't part of what a production agent needs to boot; they're a
 * dev/test-only escape hatch. No-op (the common case) unless both are set.
 */
export function maybeStartManualTunnelSession(
  env: Record<string, string | undefined> = process.env,
): void {
  const url = env.TUNNEL_ATTACH_URL;
  const sessionToken = env.TUNNEL_SESSION_TOKEN;
  if (!url && !sessionToken) return;
  if (!url || !sessionToken) {
    console.error(
      "tunnel: both TUNNEL_ATTACH_URL and TUNNEL_SESSION_TOKEN must be set to manually attach — ignoring",
    );
    return;
  }

  console.log(`tunnel: manually attaching to ${url}`);
  runTunnelSession({ url, sessionToken }).catch((error) => {
    console.error(`tunnel: session ended with an unexpected error: ${String(error)}`);
  });
}
