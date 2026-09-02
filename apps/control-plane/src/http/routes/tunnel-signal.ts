import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * The CP -> agent tunnel-signal channel's HTTP surface — one
 * `HttpApiGroup` mounted at `/api/v1/tunnel/signal`,
 * deliberately its own group rather than a fifth operation on
 * `agent-protocol.ts`'s `AgentProtocolGroup`, which is pinned to
 * exactly four operations (attest/poll/report/wake) — this is a
 * different concern from any of them — see
 * `apps/control-plane/src/tunnel/signal.ts`'s header comment for the full
 * reasoning on why this is a new channel, not a repurposed `wake`.
 *
 * A single `GET`, long-polled — see `signal.ts` for why that sidesteps the
 * same "`HttpApiEndpoint` can't model a websocket upgrade" obstacle
 * `agent-wake.ts` documents, rather than needing to solve it. Bearer-
 * authenticated exactly like `/api/v1/agent/poll`/`/report`
 * (`AgentSessionToken`) — same trust level, same mechanism, no new auth
 * concept.
 */

/** 401: the bearer session presented is missing, malformed, or expired — same failure shape
 * as `agent-protocol.ts`'s `AgentUnauthorized`, kept as its own type since this group has no
 * other reason to import that route file (mirrors `routes/tunnel.ts`'s `TunnelUnauthorized` in
 * spirit, once that unit's work lands — this build has no such file yet). */
export class TunnelSignalUnauthorized extends Schema.TaggedError<TunnelSignalUnauthorized>()(
  "TunnelSignalUnauthorized",
  { reason: Schema.String },
) {}

const TunnelSignalMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal("session_waiting"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("session_terminate"), sessionId: Schema.String }),
);

/** `signal: null` means the long poll simply timed out with nothing to deliver — not an
 * error; the agent's tunnel-signal listener is expected to call this again immediately
 * either way (`apps/agent/src/tunnel/signal-listener.ts`). */
const TunnelSignalResponse = Schema.Struct({ signal: Schema.NullOr(TunnelSignalMessage) });

export const TunnelSignalGroup = HttpApiGroup.make("tunnel-signal").add(
  HttpApiEndpoint.get("next", "/api/v1/tunnel/signal")
    .addSuccess(TunnelSignalResponse)
    .addError(TunnelSignalUnauthorized, { status: 401 }),
);
