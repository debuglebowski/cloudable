/**
 * `wake`: the optional CP → agent websocket fast path.
 * Exactly one possible message, `{"type":"pull_now"}`, no payload, and it
 * cannot carry instructions — receiving it only ever means "poll now
 * instead of waiting out the rest of the interval/backoff"; the agent
 * still finds out *what* changed via the next `poll` (see
 * `poll-report-loop.ts`, which wires `connectWake`'s `onPullNow` into the
 * sleep between cycles).
 *
 * The agent dials out — no inbound access to a machine ever;
 * the control plane accepts this connection, it never opens one — with the
 * cached bearer token. On any drop — server restart, network blip, the
 * bearer session it authenticated with expiring — this reconnects with the
 * same full-jitter backoff as the poll/report loop (`backoff.ts`), since
 * the control plane never re-dials a closed connection itself.
 *
 * Takes its URL as a parameter rather than reading `config.ts` itself —
 * `poll-report-loop.ts` (its only real caller) derives it from
 * `config.controlPlaneUrl`, but keeping that lookup out of this module
 * means a test can point `connectWake` at a mock server without touching
 * process-wide env (`config.ts` reads its env vars once, at whichever
 * module first imports it — see `poll-report-loop.test.ts`).
 */
import { DEFAULT_BACKOFF, fullJitterBackoffMs } from "./backoff";
import type { WakeMessage } from "./wire-types";

export interface WakeConnection {
  close(): void;
}

export function isWakeMessage(value: unknown): value is WakeMessage {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "pull_now"
  );
}

/**
 * Opens the wake connection and calls `onPullNow()` once per `pull_now`
 * frame received. `getBearerToken` is called fresh on every (re)connect —
 * not cached here — so a reconnect after the poll/report loop's session
 * expired picks up a newly re-attested token instead of retrying with a
 * stale one that would just be rejected again.
 */
export function connectWake(
  url: string,
  getBearerToken: () => Promise<string>,
  onPullNow: () => void,
): WakeConnection {
  let closed = false;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = fullJitterBackoffMs(attempt, DEFAULT_BACKOFF);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (closed) return;
    getBearerToken().then(
      (token) => {
        if (closed) return;

        // Wrapped, not left to throw into this `.then`'s fulfillment handler directly: a
        // synchronous throw here (e.g. `new WebSocket` on a malformed URL — see
        // `poll-report-loop.ts`'s derivation of it) would otherwise become an unhandled
        // promise rejection instead of going through the same reconnect/backoff path as
        // every other failure mode on this connection, which could crash the whole agent
        // process over what's supposed to be a non-critical, optional fast path.
        try {
          const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
          socket = ws;

          ws.addEventListener("open", () => {
            attempt = 0;
          });
          ws.addEventListener("message", (event) => {
            let parsed: unknown;
            try {
              parsed = typeof event.data === "string" ? JSON.parse(event.data) : undefined;
            } catch {
              return; // Not decodable JSON — never anything this channel is defined to send.
            }
            if (isWakeMessage(parsed)) onPullNow();
          });
          // A connection that never finished opening still reaches "close" (after "error") —
          // one reconnect path covers both a drop and a failed dial.
          ws.addEventListener("close", () => {
            if (socket === ws) socket = undefined;
            scheduleReconnect();
          });
        } catch (error) {
          console.error(`wake: failed to open a connection: ${String(error)}`);
          scheduleReconnect();
        }
      },
      (error: unknown) => {
        console.error(`wake: could not get a bearer token to connect: ${String(error)}`);
        scheduleReconnect();
      },
    );
  };

  connect();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
