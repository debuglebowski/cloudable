/**
 * `wake`: the optional CP → agent websocket fast path (spec §23/§8.1). The
 * control plane doesn't implement the server side of this yet — see
 * `apps/control-plane/src/http/routes/agent-wake.ts` for why, and this
 * unit's PR description for the tradeoff. This file exists so the wire
 * contract and the intended integration point are real and typed even
 * though there's nothing to connect to.
 *
 * To make this real: open a websocket to `${CONTROL_PLANE_URL}/api/v1/agent/wake`
 * with the cached bearer token, and on any message matching `WakeMessage`,
 * call the loop's `onPullNow` to short-circuit the current `sleep()` in
 * `poll-report-loop.ts` instead of waiting out the rest of the interval. It
 * carries no payload and cannot carry instructions — it only ever means
 * "poll now"; the agent still finds out *what* changed via the next `poll`.
 */
import type { WakeMessage } from "./wire-types";

export interface WakeConnection {
  close(): void;
}

/** Stub: does not open a connection. See file comment. */
export function connectWake(_onPullNow: () => void): WakeConnection {
  return { close(): void {} };
}

export function isWakeMessage(value: unknown): value is WakeMessage {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "pull_now"
  );
}
