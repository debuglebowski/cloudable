import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * The tunnel daemon's control-plane-facing endpoints — one
 * `HttpApiGroup` mounted at `/api/v1/tunnel`. Bearer-authenticated the same
 * way `/api/v1/agent/poll`/`/report` are (see `routes/agent-protocol.ts`),
 * NOT `CurrentUserAuthentication` — the tunnel daemon is "just another
 * attested machine identity" (the approved web-terminal plan's own framing),
 * not a browser session, so it reuses the exact same `POST /api/v1/agent/attest`
 * + `AgentSessionToken` bearer session, no new attestation method or
 * middleware needed.
 *
 * The two raw websocket routes this same plan calls for
 * (`GET /api/v1/tunnel/connect`, `GET /api/v1/access/sessions/:sessionId/attach`)
 * aren't `HttpApiEndpoint`s at all — that DSL only models HTTP verbs, not an
 * upgrade (see `agent-wake.ts`'s doc comment) — so they're mounted separately
 * in `http/handlers/tunnel.ts` via `HttpApiBuilder.Router.use(...)`, not
 * declared here.
 */

/** 401: the bearer session presented is missing, malformed, or expired — same failure shape
 * as `agent-protocol.ts`'s `AgentUnauthorized`, kept as its own type since this group has no
 * other reason to import that route file. */
export class TunnelUnauthorized extends Schema.TaggedError<TunnelUnauthorized>()(
  "TunnelUnauthorized",
  { reason: Schema.String },
) {}

// Reuses the exact response shape `access.ts`'s existing
// `/api/v1/access/session-token-public-key` endpoint already defines
// (`SessionTokenPublicKeyResponse` in `@cloudable/contracts` — `keyId` +
// base64 SPKI-DER Ed25519 key) rather than a second, differently-shaped copy.
const SessionTokenPublicKeyResponse = Schema.Struct({
  keyId: Schema.String,
  publicKeyDerBase64: Schema.String,
});

export const TunnelGroup = HttpApiGroup.make("tunnel").add(
  // Lets the daemon verify a session token's signature locally (via
  // `@cloudable/session-token`, cached and refreshed — see that package and
  // apps/tunnel-daemon's forthcoming session-manager.ts) without round-tripping
  // every attach through the control plane's own `Signer`.
  HttpApiEndpoint.get("sessionTokenPublicKey", "/api/v1/tunnel/session-token-key")
    .addSuccess(SessionTokenPublicKeyResponse)
    .addError(TunnelUnauthorized, { status: 401 }),
);
