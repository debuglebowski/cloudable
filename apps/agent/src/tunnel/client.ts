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
//   2. On connect, verifies the session token via the real, tested primitive
//      in `./session-token-verify.ts` (an exact port of the control plane's
//      own signature-check logic) before doing anything else. A failed
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
// processes; `client.test.ts` also runs relay tests through the real default.
// ---------------------------------------------------------------------------
import { type BackoffOptions, DEFAULT_BACKOFF, fullJitterBackoffMs } from "../backoff";
// The real module's `verifySessionToken` turned out to be synchronous and take an explicit
// `publicKeyDer` argument (not the `(token) => Promise<SessionClaims>` shape this file's
// call site was written against) — so the swap needed the small async adapter below, not
// just a changed import path, exactly as the now-deleted `_temp-verify-stub.ts` warned it might.
import {
  type SessionClaims,
  getSessionTokenPublicKey,
  verifySessionToken as verifySessionTokenSync,
} from "./session-token-verify";

export type { SessionClaims };

/** Adapts the real, synchronous `verifySessionToken(token, publicKeyDer)` to the
 * `(token) => Promise<SessionClaims>` shape this file's call site expects — fetching
 * (and caching, via `getSessionTokenPublicKey`'s own in-memory cache) the signer's public
 * key before doing the actual signature check. This is the default; injectable below
 * (same pattern as `spawnPty`) so `client.test.ts` can exercise the transport/relay/PTY
 * logic without needing a real signer key pair on every test — the signature-check logic
 * itself has its own dedicated, thorough test file, `session-token-verify.test.ts`. */
async function verifySessionTokenDefault(token: string): Promise<SessionClaims> {
  const publicKeyDer = await getSessionTokenPublicKey();
  return verifySessionTokenSync(token, publicKeyDer);
}

type VerifySessionToken = (token: string) => Promise<SessionClaims>;

/** `sleep` that resolves early if `signal` aborts — a plain `setTimeout` sleep would otherwise
 * make an abort during a (~10 min, at the cap) backoff wait sit unnoticed until the timer fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

/** How long to wait for a socket's send buffer to drain before giving up and running the
 * callback anyway — a send that hasn't flushed after this long is not going to. */
const FLUSH_WAIT_CAP_MS = 250;
const FLUSH_POLL_INTERVAL_MS = 10;

/** Polls `ws.bufferedAmount` until it drains (the queued "exited" frame has actually been
 * handed to the OS/network) or `FLUSH_WAIT_CAP_MS` elapses, then runs `onFlushed` — a real
 * flush signal instead of guessing that one macrotask is always enough. */
function waitForFlush(ws: WebSocket, onFlushed: () => void): void {
  const deadline = Date.now() + FLUSH_WAIT_CAP_MS;
  const check = () => {
    if (ws.bufferedAmount === 0 || Date.now() >= deadline) {
      onFlushed();
      return;
    }
    setTimeout(check, FLUSH_POLL_INTERVAL_MS);
  };
  // Always defer the first check by one tick, rather than checking synchronously: for a small
  // local message, `bufferedAmount` can already read 0 the instant `send()` returns — reflecting
  // "handed to the socket", not "actually reached the peer" — so an immediate check would give
  // this function no more of a real guarantee than the blind `setTimeout(0)` it replaced.
  setTimeout(check, FLUSH_POLL_INTERVAL_MS);
}

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
      // Deliberately no `exit` handler here: `TerminalOptions.exit`'s `exitCode` is a PTY
      // *stream* lifecycle status (0 = clean EOF, 1 = read error), NOT the child process's
      // exit code, per Bun's own docs ("Use Subprocess.exited ... for the process exit
      // information"). `proc.exited` below is the real exit code.
    },
  });

  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill();
    throw new Error("Bun.Terminal unavailable on this platform (POSIX only)");
  }

  proc.exited.then((exitCode) => callbacks.onExit(exitCode));

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
  /** Injection point for tests — defaults to the real signature check (`verifySessionTokenDefault`).
   * Only ever override this to test transport/relay behavior in isolation; never in anything
   * that resembles a real session — see this file's own header comment on why verification
   * must be real. */
  readonly verifySessionToken?: VerifySessionToken;
  readonly backoff?: BackoffOptions;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

// Hoisted rather than constructed per message — this relay can run for hours, and every
// `data` frame would otherwise allocate a throwaway decoder.
const textDecoder = new TextDecoder();

function decodeMessageText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return textDecoder.decode(data);
  }
  return undefined;
}

/** A sane ceiling on terminal dimensions from a `resize` message — not a real terminal size
 * limit, just a guard against a malformed/hostile value reaching `pty.resize()` unchecked. */
const MAX_TERMINAL_DIMENSION = 10_000;

/** Result of one connection attempt (`connectAndRelay`). `doneForGood` tells the caller
 * whether to stop retrying at all; `everAttached` tells it whether THIS attempt got far enough
 * to spawn a PTY, so the backoff counter can reset after a healthy period instead of creeping
 * toward the cap forever (mirrors `poll-report-loop.ts` resetting `attempt` after success). */
interface ConnectResult {
  readonly doneForGood: boolean;
  readonly everAttached: boolean;
}

/**
 * One connection attempt, spanning the session's lifetime until it ends —
 * cleanly (`terminate`, the process exiting on its own, or an abort signal)
 * or unexpectedly (the socket dropping). Never throws: every failure path
 * resolves rather than rejects, so the caller's reconnect loop can back off
 * and retry without its own try/catch.
 *
 * `doneForGood` is true when the session is over for good (retrying would be
 * pointless or wrong — a rejected token, an explicit `terminate`, the
 * process exiting, or the caller aborting), false when the connection was
 * lost unexpectedly and the caller should reconnect.
 */
function connectAndRelay(
  options: Required<
    Pick<TunnelSessionOptions, "url" | "sessionToken" | "spawnPty" | "verifySessionToken">
  > &
    Pick<TunnelSessionOptions, "cols" | "rows" | "signal">,
): Promise<ConnectResult> {
  return new Promise<ConnectResult>((resolve) => {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    let settled = false;
    let everAttached = false;
    let pty: PtyHandle | undefined;

    const finish = (doneForGood: boolean) => {
      if (settled) return;
      settled = true;
      // Every call to `connectAndRelay` (one per reconnect attempt) adds its own `abort`
      // listener to the SAME long-lived `AbortSignal` passed in from `runTunnelSession` —
      // without removing it here, each reconnect would leak one more listener onto that
      // signal for the lifetime of the whole session.
      options.signal?.removeEventListener("abort", onAbort);
      // Guarded: `finish` runs directly from native `close`/`error`/`abort` event dispatch, not
      // from inside an async/await chain — a throwing `kill()` here (a plausible failure mode
      // for any `SpawnPty` implementation, test fakes included) would otherwise be an uncaught
      // exception outside anything that could catch it, up to and including crashing the agent.
      try {
        pty?.kill();
      } catch (error) {
        console.error(`tunnel: error killing PTY: ${String(error)}`);
      }
      try {
        ws.close();
      } catch {
        // already closed/closing, or never successfully constructed — fine.
      }
      resolve({ doneForGood, everAttached });
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(options.url);
    } catch (error) {
      // `new WebSocket(...)` can throw synchronously for a malformed URL — a real failure
      // mode this promise must still resolve (not throw) for, per this function's own contract.
      console.error(`tunnel: failed to open websocket: ${String(error)}`);
      resolve({ doneForGood: false, everAttached: false });
      return;
    }

    const send = (message: TunnelWireMessage) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // socket already closing/closed — nothing left to relay to.
      }
    };

    ws.addEventListener("open", () => {
      options.verifySessionToken(options.sessionToken).then(
        (claims) => {
          // The connection may already have ended (aborted, or the socket dropped) while
          // verification was pending — spawning a PTY now would orphan it: nothing would ever
          // kill it, since `finish` (the only thing that kills a `pty`) already ran.
          if (settled) return;

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
                // `finish` closes the socket, and closing immediately after `send()` can race
                // the underlying write before it flushes — waiting for `ws.bufferedAmount` to
                // drain (capped, so a socket that never drains still terminates promptly) gives
                // the "exited" notification a real chance to reach the other side, rather than
                // just guessing one macrotask is enough.
                waitForFlush(ws, () => finish(true));
              },
            });
            everAttached = true;
          } catch (error) {
            console.error(`tunnel: failed to spawn PTY, closing: ${String(error)}`);
            finish(false); // a local spawn failure may well be transient — retry.
          }
        },
        (error) => {
          if (settled) return;
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
          if (
            typeof newCols === "number" &&
            typeof newRows === "number" &&
            Number.isInteger(newCols) &&
            Number.isInteger(newRows) &&
            newCols > 0 &&
            newRows > 0 &&
            newCols <= MAX_TERMINAL_DIMENSION &&
            newRows <= MAX_TERMINAL_DIMENSION
          ) {
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
    ws.addEventListener("error", (event) => {
      console.error(`tunnel: websocket error: ${String(event)}`);
      if (!settled) finish(false);
    });

    const onAbort = () => finish(true);
    options.signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Maintains a tunnel session for its full lifetime, reconnecting with full-jitter backoff
 * (see `backoff.ts`) if the connection drops unexpectedly — modeled on `poll-report-loop.ts`'s
 * `for(;;)` + `AbortSignal` shape, not a different pattern. `attempt` resets to 0 once a
 * connection actually attaches (mirroring `poll-report-loop.ts` resetting after every
 * successful cycle), so a long healthy session followed by one transient drop reconnects
 * quickly rather than picking up wherever the backoff had crept to. Returns once the session
 * has ended for good (clean termination, the process exiting, a rejected token, or an aborted
 * signal).
 */
export async function runTunnelSession(options: TunnelSessionOptions): Promise<void> {
  const spawnPty = options.spawnPty ?? spawnRealPty;
  const verifySessionToken = options.verifySessionToken ?? verifySessionTokenDefault;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let attempt = 0;

  for (;;) {
    if (options.signal?.aborted) return;

    const result = await connectAndRelay({ ...options, spawnPty, verifySessionToken });
    if (result.doneForGood) return;
    if (options.signal?.aborted) return;

    if (result.everAttached) attempt = 0;
    const delay = fullJitterBackoffMs(attempt, backoff);
    attempt += 1;
    console.log(
      `tunnel: connection lost, reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`,
    );
    await sleep(delay, options.signal);
  }
}

/**
 * Value `TUNNEL_MANUAL_TRIGGER_ACK` must equal, in addition to both `TUNNEL_ATTACH_URL` and
 * `TUNNEL_SESSION_TOKEN`, to actually enable the manual trigger below. Requiring all three
 * (rather than just the two that carry real data) makes it very hard to enable this by
 * accident — e.g. a leaked/templated `TUNNEL_ATTACH_URL` and `TUNNEL_SESSION_TOKEN` reaching a
 * real deployment's environment would otherwise be enough, on its own, to open a PTY session.
 * The signature check itself is real (`./session-token-verify.ts`), so this path can't be used
 * with a forged token — but it still bypasses the control plane's `mintSession` policy gate and
 * audit trail: a genuinely-issued token fed in this way attaches without the session ever being
 * recorded through the normal mint flow, and without the not-yet-built CP→agent signaling
 * channel deciding when to attach. This value is deliberately not a secret; it exists purely as
 * a deliberate, hard-to-fat-finger acknowledgment, not an access control.
 */
export const TUNNEL_MANUAL_TRIGGER_ACK =
  "i-understand-this-bypasses-the-control-plane-session-policy-gate";

/**
 * Manual "attach now" trigger for this unit (a separate sibling unit owns real CP→agent
 * signaling — see this unit's PR description). Reads `TUNNEL_ATTACH_URL`, `TUNNEL_SESSION_TOKEN`,
 * and `TUNNEL_MANUAL_TRIGGER_ACK` directly from the environment — deliberately NOT added to
 * `config.ts`'s shared object, since these aren't part of what a production agent needs to boot;
 * they're a dev/test-only escape hatch, gated by all three being set (see
 * `TUNNEL_MANUAL_TRIGGER_ACK`'s own doc comment for why three, not two). No-op (the common case)
 * unless all three are present and correct.
 *
 * Returns the session's `AbortController` when actually started (so a caller — `index.ts` — can
 * abort it during shutdown instead of leaving an orphaned PTY/socket behind a `process.exit()`),
 * or `undefined` when it was a no-op.
 */
export function maybeStartManualTunnelSession(
  env: Record<string, string | undefined> = process.env,
): AbortController | undefined {
  const url = env.TUNNEL_ATTACH_URL;
  const sessionToken = env.TUNNEL_SESSION_TOKEN;
  const ack = env.TUNNEL_MANUAL_TRIGGER_ACK;
  if (!url && !sessionToken && !ack) return undefined;
  if (!url || !sessionToken || ack !== TUNNEL_MANUAL_TRIGGER_ACK) {
    console.error(
      `tunnel: manual attach requires TUNNEL_ATTACH_URL, TUNNEL_SESSION_TOKEN, and TUNNEL_MANUAL_TRIGGER_ACK="${TUNNEL_MANUAL_TRIGGER_ACK}" — all three, exactly — ignoring. This trigger bypasses the control plane's session policy gate and audit trail entirely; never enable it outside a manual dev/test check.`,
    );
    return undefined;
  }

  console.log(`tunnel: manually attaching to ${url}`);
  const controller = new AbortController();
  runTunnelSession({ url, sessionToken, signal: controller.signal }).catch((error) => {
    console.error(`tunnel: session ended with an unexpected error: ${String(error)}`);
  });
  return controller;
}
