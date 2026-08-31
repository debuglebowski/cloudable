// ---------------------------------------------------------------------------
// Agent-side counterpart to `apps/control-plane/src/tunnel/session-token.ts`'s
// `verifySessionToken` — spec §11.1: "The agent validates the signature
// before attaching [a session]." Until this file existed there was zero
// agent-side implementation of that check at all; this provides the tested
// crypto primitive a tunnel daemon MUST call on every session attach.
//
// It does not by itself close the gap end-to-end: `apps/agent` has no
// tunnel daemon / session-attach transport yet to call it from (see
// docs/agents.md's "Tunnel daemon (spec-level only — not implemented in
// this build)" and docs/access.md §4 — wiring an actual reverse-tunnel
// process into `apps/agent` is explicitly future work for whichever unit
// builds that half). Today, only this file's own test calls
// `verifySessionToken`. Whichever unit adds the session-attach path must
// call it there, synchronously, before doing anything else with the token.
//
// This file only ever touches the session-token signer's PUBLIC key (fetched
// from `GET /api/v1/access/session-token-public-key`, see
// `getSessionTokenPublicKey` below) — it never generates, holds, or receives
// private key material (CLAUDE.md invariant #9). Unlike the control plane,
// the agent has no `Signer` port to call: the public key is not sensitive,
// so it is fetched once over the same bearer-authenticated `apiRequest`
// wrapper as every other control-plane call and cached in memory.
//
// The crypto/ordering logic in `verifySessionToken` below is a deliberate,
// exact port of the control plane's version — same failure-`reason`
// taxonomy (`malformed`, `malformed_key`, `invalid_signature`, `expired`),
// same "never trust claims content until the signature over those exact
// bytes is confirmed genuine" ordering — so a future refactor could share
// the type between the two processes.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";
import type { SessionTokenPublicKeyResponse } from "../wire-types";

// `apiRequest` is intentionally NOT a static top-level import here: `../http-client`
// eagerly imports `./config`, whose top-level `required("CONTROL_PLANE_URL")` throws
// synchronously at *module load* if that env var is unset. That's fine for the real agent
// process (which always has it set), but it would mean merely importing this file — to get
// at the pure, network-free `verifySessionToken` — transitively crashes in any context that
// hasn't set that env var (e.g. running this file's own test standalone). Deferring the
// import to `getSessionTokenPublicKey`'s first call keeps `verifySessionToken` env-independent.
type ApiRequestFn = <T>(path: string, init?: RequestInit) => Promise<T>;
let apiRequestFn: ApiRequestFn | undefined;
async function loadApiRequest(): Promise<ApiRequestFn> {
  if (!apiRequestFn) {
    ({ apiRequest: apiRequestFn } = await import("../http-client"));
  }
  return apiRequestFn;
}

export type SessionMethod = "terminal" | "ssh";

export interface SessionClaims {
  readonly idpIdentity: string;
  readonly targetMachineId: string;
  readonly targetOsUser: string;
  readonly method: SessionMethod;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type SessionTokenVerifyReason =
  | "malformed"
  | "malformed_key"
  | "invalid_signature"
  | "expired";

/**
 * Thrown by `verifySessionToken`. There is no code path that returns
 * `SessionClaims` without a passing signature check first — including for
 * an expired token, which fails with `reason: "expired"` only *after* the
 * signature over its (stale) claims is confirmed genuine. An attacker must
 * not be able to learn anything, including "the claims were well-formed",
 * from an unsigned or mis-signed token.
 */
export class SessionTokenVerificationError extends Error {
  constructor(
    public readonly reason: SessionTokenVerifyReason,
    cause?: unknown,
  ) {
    super(`session token rejected: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "SessionTokenVerificationError";
  }
}

interface RawClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: SessionMethod;
  issuedAt: string;
  expiresAt: string;
}

function isRawClaims(value: unknown): value is RawClaims {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.idpIdentity === "string" &&
    typeof v.targetMachineId === "string" &&
    typeof v.targetOsUser === "string" &&
    (v.method === "terminal" || v.method === "ssh") &&
    typeof v.issuedAt === "string" &&
    typeof v.expiresAt === "string"
  );
}

const fromBase64Url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Verifies a session token's signature and expiry against the given
 * session-token signer public key (SPKI DER bytes — see
 * `getSessionTokenPublicKey`). Throws `SessionTokenVerificationError` on any
 * failure; returns the verified claims otherwise.
 *
 * Deliberately synchronous and pure — no network/HTTP call in here, and no
 * dependency on which key was fetched or how — so it's directly testable
 * against a locally generated keypair with no control plane involved.
 */
export function verifySessionToken(token: string, publicKeyDer: Uint8Array): SessionClaims {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new SessionTokenVerificationError("malformed", "expected `<claims>.<signature>`");
  }
  const [claimsSegment, signatureSegment] = parts as [string, string];

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyDer),
      format: "der",
      type: "spki",
    });
  } catch (cause) {
    throw new SessionTokenVerificationError("malformed_key", cause);
  }

  // Plain try/catch: a malformed signature segment throwing and a
  // well-formed-but-wrong signature both mean "not valid," not a distinct
  // error class — both collapse to `invalid_signature` below.
  let signatureValid: boolean;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(utf8(claimsSegment)),
      publicKey,
      Buffer.from(fromBase64Url(signatureSegment)),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new SessionTokenVerificationError("invalid_signature");
  }

  // Only decode/trust claims content once the signature over those exact bytes is confirmed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(claimsSegment)));
  } catch (cause) {
    throw new SessionTokenVerificationError("malformed", cause);
  }
  if (!isRawClaims(parsed)) {
    throw new SessionTokenVerificationError("malformed", "unexpected claim shape");
  }

  const expiresAt = new Date(parsed.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new SessionTokenVerificationError("expired");
  }

  return {
    idpIdentity: parsed.idpIdentity,
    targetMachineId: parsed.targetMachineId,
    targetOsUser: parsed.targetOsUser,
    method: parsed.method,
    issuedAt: new Date(parsed.issuedAt),
    expiresAt,
  };
}

async function fetchPublicKeyFromControlPlane(): Promise<SessionTokenPublicKeyResponse> {
  const apiRequest = await loadApiRequest();
  return apiRequest<SessionTokenPublicKeyResponse>("/api/v1/access/session-token-public-key");
}

let cachedPublicKeyDer: Uint8Array | undefined;
// De-dupes concurrent first callers into a single outstanding request — spec §11.1 calls out
// verification running "on every session attach, including under load"; without this, several
// session attaches racing in before anything is cached would each fire their own request
// against the control plane (a latent thundering herd of exactly the kind that matters here).
let inFlightFetch: Promise<Uint8Array> | undefined;

/**
 * Fetches the session-token signer's public key from the control plane
 * (`GET /api/v1/access/session-token-public-key`) and caches it in-process
 * for the remainder of this agent's lifetime. This is a public key, not
 * secret material (CLAUDE.md invariant #9) — there is no expiry to track,
 * unlike `attestation.ts`'s bearer-token cache, so a plain in-memory cache
 * with an explicit invalidation escape hatch (`clearCachedSessionTokenPublicKey`)
 * is enough.
 *
 * `fetchPublicKey` defaults to the real control-plane call and every real
 * caller should just call `getSessionTokenPublicKey()` with no argument —
 * it's overridable purely so this function's caching/de-dup/decoding logic
 * is unit-testable without going through `config.ts`'s process-wide,
 * frozen-on-first-import `CONTROL_PLANE_URL` (which `bun test`'s shared
 * module cache across test files makes order-dependent to point at a real
 * server from here).
 */
export async function getSessionTokenPublicKey(
  fetchPublicKey: () => Promise<SessionTokenPublicKeyResponse> = fetchPublicKeyFromControlPlane,
): Promise<Uint8Array> {
  if (cachedPublicKeyDer) return cachedPublicKeyDer;
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    const response = await fetchPublicKey();
    return new Uint8Array(Buffer.from(response.publicKeyDerBase64, "base64"));
  })();

  try {
    cachedPublicKeyDer = await inFlightFetch;
    return cachedPublicKeyDer;
  } finally {
    // Cleared whether the fetch succeeded or failed — a failure must not permanently wedge
    // every later call onto the same rejected promise; the next call retries from scratch.
    inFlightFetch = undefined;
  }
}

/** Forces the next `getSessionTokenPublicKey()` call to refetch — e.g. after a key rotation. */
export function clearCachedSessionTokenPublicKey(): void {
  cachedPublicKeyDer = undefined;
}
