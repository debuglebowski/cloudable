// ---------------------------------------------------------------------------
// Caches the session-token signer's public key
// (`GET /api/v1/tunnel/session-token-key`) so the daemon can verify a
// session token's signature locally (`@cloudable/session-token`) on every
// attach without round-tripping through the control plane each time — spec
// §11.1's "validate the signature on every session, including under load"
// would make a network call per attach a real bottleneck otherwise.
//
// Not `apiRequest` (http-client.ts) — that's documented pre-attestation-only
// (uses `config.machineToken`). This call authenticates with the daemon's
// own real bearer session from `attest()`, same convention as apps/agent's
// poll/report (raw `fetch` with an explicit `Authorization` header, not the
// pre-attest helper).
// ---------------------------------------------------------------------------
import { config } from "./config";
import { ApiError } from "./http-client";
import type { SessionTokenPublicKeyResponse } from "./wire-types";

/** Refreshed at most this often on a healthy path — the key changes only on a deliberate
 * signer rotation, which is rare and not time-sensitive to pick up within the hour. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

interface CachedPublicKey {
  readonly response: SessionTokenPublicKeyResponse;
  readonly fetchedAt: number;
}

let cached: CachedPublicKey | undefined;

const isFresh = (entry: CachedPublicKey): boolean =>
  Date.now() - entry.fetchedAt < REFRESH_INTERVAL_MS;

/**
 * Forces the next `getSessionTokenPublicKey` call to re-fetch. Intended caller:
 * session-manager.ts's attach handler, on a verification failure specifically tagged
 * `invalid_signature` — the key may have rotated since the last fetch, so one eager
 * refresh-and-retry is worth it before actually rejecting the attach. Not called for
 * `expired`/`malformed` failures, which a fresh key can't fix.
 */
export function clearCachedSessionTokenPublicKey(): void {
  cached = undefined;
}

async function fetchSessionTokenPublicKey(
  bearerToken: string,
): Promise<SessionTokenPublicKeyResponse> {
  const res = await fetch(`${config.controlPlaneUrl}/api/v1/tunnel/session-token-key`, {
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
  return res.json() as Promise<SessionTokenPublicKeyResponse>;
}

/**
 * Returns the cached public key if it's less than an hour old, otherwise fetches a fresh
 * one and caches it. `bearerToken` is the daemon's own attested session (`attestation.ts`'s
 * `attest()`), not a per-session credential — this call is authenticated as the daemon's
 * machine identity, same as every other control-plane call it makes.
 */
export async function getSessionTokenPublicKey(
  bearerToken: string,
): Promise<SessionTokenPublicKeyResponse> {
  if (cached && isFresh(cached)) return cached.response;
  const response = await fetchSessionTokenPublicKey(bearerToken);
  cached = { response, fetchedAt: Date.now() };
  return response;
}
