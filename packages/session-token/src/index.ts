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

/**
 * Which kind of session a token authorizes. The daemon branches on this claim
 * — and ONLY on this claim, never on anything the `attach` frame carries — to
 * decide whether to spawn a PTY or a file-browsing helper. That is what keeps
 * the two elevation levels (`file_recovery` vs `shell`,
 * `apps/control-plane/src/tunnel/access-authorization.ts`) apart in practice:
 * a token minted for `"files"` cannot be made to open a shell by a caller who
 * rewrites the frame, because the frame is not consulted.
 */
export type SessionMethod = "terminal" | "ssh" | "files";

export interface SessionClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  /** `string`, not `SessionMethod` — see `RawClaims.method` for why. A consumer must match
   * it exhaustively and refuse what it does not recognise, never fall through to a default. */
  method: string;
  issuedAt: Date;
  expiresAt: Date;
}

interface RawClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  /**
   * Deliberately `string`, not `SessionMethod`.
   *
   * This is the VERSION-SKEW seam. A machine runs a compiled daemon that can be older than
   * the control plane by weeks, and the claim set is additive — `"files"` was added after
   * daemons were already deployed. When the guard below required a known literal, an older
   * daemon rejected a perfectly well-formed, correctly-signed token naming a newer method as
   * `"malformed"`, and the operator saw "This session has ended (malformed)" with nothing to
   * act on. The token was fine; the daemon simply could not serve that method, which is a
   * different fact and deserves to be said out loud (`session-manager.ts` answers
   * `unsupported_method`).
   *
   * Widening this is safe because the signature is verified BEFORE these claims are parsed:
   * whatever is here was put there by the control plane, so it is authentic data rather than
   * caller input. What it is NOT is a capability check — the daemon must still decide whether
   * it implements the named method, and must refuse rather than fall back to a default.
   */
  method: string;
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
    typeof v.method === "string" &&
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
 * Verifies a session token's signature and expiry against the given ECDSA
 * P-256 public key (DER/SPKI-encoded, as returned by `Signer.publicKey()`).
 *
 * P-256 rather than Ed25519 because the signing key lives in Azure Key Vault
 * in a real deployment, and Key Vault has no Ed25519 (RSA, EC and oct only) —
 * see `apps/control-plane/src/services/Signer.azure.ts`. The signature is
 * fixed-width r||s ("ieee-p1363"), which is what Key Vault's ES256 returns.
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
      "sha256",
      Buffer.from(utf8(claimsSegment)),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
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
