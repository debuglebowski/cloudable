// ---------------------------------------------------------------------------
// Pure, framework-free verification for Cloudable's signed session tokens.
// The agent must validate the signature on every session,
// including under load.
//
// This is the ONE place the byte-level check (split -> verify signature over
// the exact claims-segment bytes -> only then parse claims -> check expiry)
// is allowed to live. It is lifted verbatim from
// `apps/control-plane/src/tunnel/session-token.ts`'s original
// `verifySessionToken` — that file now wraps this package rather than
// re-implementing the check, and the (forthcoming) tunnel-daemon imports
// this package directly.
//
// Why a real package instead of two copies: the daemon can't import
// control-plane's version (cross-app, and it's wrapped in
// `Effect<..., SignerError, SignerTag>`, which pulls in `effect` entirely —
// something the daemon deliberately avoids, matching `apps/agent`'s
// zero-Effect convention). Two independent copies of signature-verification
// logic is exactly the kind of drift where one side silently accepts what
// the other would reject. This package has no dependencies beyond Node's
// built-in `node:crypto` and does no I/O — the caller is responsible for
// fetching the public key (from `Signer.publicKey()` control-plane-side, or
// from a cached `GET /api/v1/tunnel/session-token-key` response
// daemon-side) and handing it in.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";

export type SessionMethod = "terminal" | "ssh";

export interface SessionClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: SessionMethod;
  issuedAt: Date;
  expiresAt: Date;
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

export type VerifyFailureReason = "malformed" | "malformed_key" | "invalid_signature" | "expired";

export type VerifySessionTokenResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: VerifyFailureReason; cause?: unknown };

/**
 * Verifies a session token's signature and expiry against the given ed25519
 * public key (DER/SPKI-encoded, as returned by `Signer.publicKey()`).
 *
 * `keyId` selection (which key this public key even corresponds to) is the
 * caller's job, deliberately — this function only ever checks the token
 * against the one key it's handed. Trusting an attacker-supplied key
 * identifier from inside the token itself to pick which key to verify
 * against is a classic signature-confusion bug class; neither this function
 * nor either of its callers do that.
 */
export function verifySessionToken(
  token: string,
  publicKeyDer: Uint8Array,
): VerifySessionTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed", cause: "expected `<claims>.<signature>`" };
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
    return { ok: false, reason: "malformed_key", cause };
  }

  // A malformed signature segment throwing and a well-formed-but-wrong signature both mean
  // "not valid" — a `false` result, not a distinct thrown error.
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
    return { ok: false, reason: "invalid_signature" };
  }

  // Only decode/trust claims content once the signature over those exact bytes is confirmed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(claimsSegment)));
  } catch (cause) {
    return { ok: false, reason: "malformed", cause };
  }
  if (!isRawClaims(parsed)) {
    return { ok: false, reason: "malformed", cause: "unexpected claim shape" };
  }

  const expiresAt = new Date(parsed.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    claims: {
      idpIdentity: parsed.idpIdentity,
      targetMachineId: parsed.targetMachineId,
      targetOsUser: parsed.targetOsUser,
      method: parsed.method,
      issuedAt: new Date(parsed.issuedAt),
      expiresAt,
    },
  };
}
