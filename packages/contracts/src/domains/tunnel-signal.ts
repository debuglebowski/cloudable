/**
 * Wire types for the CP -> agent tunnel-signal channel (docs/spec.md §8.2,
 * §11.1 — the web terminal / SSH session path). Deliberately its own
 * channel, NOT a repurposed `wake` (agent-protocol.ts):
 *
 * - `wake` (spec §8.1/§23) is the control agent's own fast path for its
 *   desired-state poll loop. Spec pins it to "exactly one message, pull
 *   now, with no payload. It cannot carry instructions" — a session id
 *   would BE an instruction, and `wake`'s job (accelerate the next
 *   `/poll`) has nothing to do with tunnel sessions at all.
 * - The agent protocol (spec §23) is pinned to exactly four operations —
 *   attest/poll/report/wake. There is no slot in it for "attach to
 *   session X", so this is a fifth, separate CP -> agent surface, not an
 *   addition to that group.
 *
 * Kept as minimal as `wake`'s own payload-free design allows: just which
 * of two things happened, and a session id — never a session token or any
 * other session detail. The agent's tunnel client (a sibling unit,
 * apps/agent/src/tunnel/client.ts) is the one that verifies the session
 * token and actually opens the reverse tunnel; this channel only ever
 * means "session <id> is waiting, connect now" or "session <id>, stop".
 *
 * Plain TS types, not Effect Schema, matching `agent-protocol.ts`'s own
 * convention — this package stays framework-free so the agent's
 * dependency surface stays thin (CLAUDE.md / docs/spec.md §25).
 */
export type TunnelSignalMessage =
  | { readonly type: "session_waiting"; readonly sessionId: string }
  | { readonly type: "session_terminate"; readonly sessionId: string };

/** `GET /api/v1/tunnel/signal` response body — long-polled by the agent's
 * tunnel-signal listener. `signal: null` means the long poll simply timed
 * out with nothing to deliver; the caller reconnects immediately either way. */
export interface TunnelSignalResponse {
  readonly signal: TunnelSignalMessage | null;
}
