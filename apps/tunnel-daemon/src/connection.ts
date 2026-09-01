// ---------------------------------------------------------------------------
// The daemon's persistent outbound connection (spec §8.2's "reverse tunnel
// over an outbound connection") — one websocket to the control plane's
// `GET /api/v1/tunnel/connect` (control-plane side built and live-verified
// separately), multiplexing every session on this machine over it via
// `session-manager.ts`. Never accepts inbound traffic (invariant #7): this
// file only ever opens connections outward.
//
// `attest()`/`fullJitterBackoffMs` are the same primitives `apps/agent`'s
// `poll-report-loop.ts` uses — same full-jitter-with-cap reconnect
// reasoning (spec §8.1's "the failure mode is a synchronised fleet-wide
// poll after a control plane outage" applies just as much to a fleet of
// tunnel daemons all trying to reconnect at once).
// ---------------------------------------------------------------------------
import type { TunnelFrame } from "@cloudable/contracts";
import { attest } from "./attestation";
import { DEFAULT_BACKOFF, fullJitterBackoffMs } from "./backoff";
import { config } from "./config";
import type { SessionManager } from "./session-manager";

/** A connection that stayed open at least this long resets the reconnect backoff to zero —
 * without this floor, a server that accepts the upgrade and then immediately drops the
 * connection would look like "success" every time and never actually back off, defeating
 * the whole point of the backoff (a persistently-failing endpoint would be hammered at
 * full speed instead of slowing down). */
const MIN_STABLE_CONNECTION_MS = 5_000;

type CreateWebSocket = (url: string, options: { headers: Record<string, string> }) => WebSocket;

export interface ConnectionDeps {
  /** e.g. `ws://localhost:4780/api/v1/tunnel/connect` — the caller builds this from
   * `config.controlPlaneUrl` so tests can point it anywhere without touching `config`. */
  wsUrl: string;
  sessionManager: SessionManager;
  /** Defaults to `attest()` from `attestation.ts` — injectable so tests don't need a real
   * control-plane round trip just to get a bearer token. */
  attest?: () => Promise<{ bearerToken: string }>;
  /** Defaults to the real global `WebSocket` — injectable for tests. */
  createWebSocket?: CreateWebSocket;
  /** Defaults to a real `setTimeout`-based sleep — injectable so tests don't have to wait
   * through real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

const isTunnelFrame = (value: unknown): value is TunnelFrame =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === "string" &&
  typeof (value as { sessionId?: unknown }).sessionId === "string";

async function handleInboundFrame(
  sessionManager: SessionManager,
  send: (frame: TunnelFrame) => void,
  raw: string | Uint8Array,
): Promise<void> {
  let parsed: unknown;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    parsed = JSON.parse(text);
  } catch {
    return; // Malformed frame from the control plane — ignore rather than crash the
    // whole connection over one bad message.
  }
  if (!isTunnelFrame(parsed)) return;
  const frame = parsed;

  switch (frame.kind) {
    case "attach": {
      const outcome = await sessionManager.attach(
        {
          sessionId: frame.sessionId,
          sessionToken: frame.sessionToken,
          cols: frame.cols,
          rows: frame.rows,
        },
        {
          onData: (bytes) =>
            send({
              kind: "data",
              sessionId: frame.sessionId,
              dataBase64: Buffer.from(bytes).toString("base64"),
            }),
          // The PTY's own child process exited on its own (the shell was closed, the
          // program ran to completion) — this is a real, valid way for a session to end,
          // distinct from either side deliberately closing it.
          onExit: () =>
            send({ kind: "close", sessionId: frame.sessionId, reason: "process_exited" }),
        },
      );
      send(
        outcome.ok
          ? { kind: "attached", sessionId: frame.sessionId }
          : { kind: "attach_rejected", sessionId: frame.sessionId, reason: outcome.reason },
      );
      break;
    }
    case "data":
      sessionManager.data(frame.sessionId, Buffer.from(frame.dataBase64, "base64"));
      break;
    case "resize":
      sessionManager.resize(frame.sessionId, frame.cols, frame.rows);
      break;
    case "close":
      sessionManager.close(frame.sessionId);
      break;
    // "attached"/"attach_rejected" are frames THIS daemon sends, not receives — the control
    // plane never sends them back. Nothing to do if one somehow arrives here.
    case "attached":
    case "attach_rejected":
      break;
  }
}

type ConnectionCloseReason = "closed" | "error";

/**
 * One connection attempt: opens the websocket, dispatches inbound frames until it closes
 * or errors, then resolves (never rejects) with why.
 *
 * `signal` matters here specifically because a live connection has no other natural end —
 * unlike `apps/agent`'s poll/report loop (each cycle is one short-lived `fetch` that always
 * eventually settles on its own), this promise would otherwise never resolve until the
 * *remote* end drops it. Without wiring the abort into an actual `ws.close()`, "the only way
 * out" (this function's own doc comment on `runConnectionLoop`) would be a documented lie
 * for as long as a connection stays up — confirmed the hard way running this live against a
 * real control plane during development, where an aborted loop kept the process alive
 * indefinitely until the connection was killed some other way.
 */
function runOneConnection(
  deps: {
    wsUrl: string;
    bearerToken: string;
    sessionManager: SessionManager;
    createWebSocket: CreateWebSocket;
  },
  signal?: AbortSignal,
): Promise<ConnectionCloseReason> {
  return new Promise((resolve) => {
    const ws = deps.createWebSocket(deps.wsUrl, {
      headers: { authorization: `Bearer ${deps.bearerToken}` },
    });

    let settled = false;
    const finish = (reason: ConnectionCloseReason) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(reason);
    };

    const onAbort = () => {
      try {
        ws.close();
      } catch {
        // Already closing/closed — `onclose` below will still fire and settle this.
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);

    const send = (frame: TunnelFrame): void => {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // The socket is already closing/closed — the `onclose`/`onerror` handler below
        // will settle this connection attempt; nothing further to do here.
      }
    };

    ws.onmessage = (event) => {
      void handleInboundFrame(deps.sessionManager, send, event.data as string | Uint8Array);
    };
    ws.onerror = () => finish("error");
    ws.onclose = () => finish("closed");
  });
}

/**
 * The daemon's main loop: attest, connect, relay until the connection ends, back off with
 * full jitter, repeat. Runs forever; `signal` is the only way out (used by tests).
 */
export async function runConnectionLoop(
  deps: ConnectionDeps,
  options: { signal?: AbortSignal } = {},
): Promise<never> {
  const attestFn = deps.attest ?? attest;
  const createWebSocket: CreateWebSocket =
    deps.createWebSocket ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempt = 0;

  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("connection loop aborted");
    }

    const startedAt = Date.now();
    try {
      const session = await attestFn();
      const reason = await runOneConnection(
        {
          wsUrl: deps.wsUrl,
          bearerToken: session.bearerToken,
          sessionManager: deps.sessionManager,
          createWebSocket,
        },
        options.signal,
      );
      console.log(`tunnel connection ended (${reason}) after ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error(`tunnel connection attempt failed: ${String(error)}`);
    }

    // Check again immediately, before backing off — an abort that just closed a live
    // connection (see `runOneConnection`'s own doc comment) shouldn't cost an extra,
    // pointless backoff sleep before this loop notices it's supposed to be stopping;
    // confirmed live during development, where this cost a real ~800ms of shutdown lag.
    if (options.signal?.aborted) {
      throw new Error("connection loop aborted");
    }

    if (Date.now() - startedAt >= MIN_STABLE_CONNECTION_MS) {
      attempt = 0;
    }
    const delay = fullJitterBackoffMs(attempt, DEFAULT_BACKOFF);
    attempt += 1;
    console.log(`backing off ${Math.round(delay)}ms before reconnecting (attempt ${attempt})`);
    await sleep(delay);
  }
}

/** Builds the real `wss?://…/api/v1/tunnel/connect` URL from `config.controlPlaneUrl` — a
 * plain `http(s)://` control-plane URL, same convention `apps/agent` uses for its own
 * `fetch` calls (the daemon's outbound websocket is the one place this daemon needs a
 * `ws(s)://` scheme instead). */
export function tunnelConnectUrl(controlPlaneUrl: string = config.controlPlaneUrl): string {
  const url = new URL("/api/v1/tunnel/connect", controlPlaneUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
