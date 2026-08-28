// ---------------------------------------------------------------------------
// Signed session tokens (spec §11.1): "The control plane mints a short-lived
// token carrying IdP identity, target machine and target OS user, signed
// via the same Key Vault sign operation as the SSH CA. The agent validates
// the signature before attaching."
//
// This file only ever calls `Signer.sign()` / `Signer.publicKey()` — it
// never generates or holds key material itself (CLAUDE.md invariant #9).
// `crypto.createPublicKey`/`crypto.verify` below operate on the CA's PUBLIC
// key only (returned by `Signer.publicKey()`), which is not sensitive
// material — verification is deliberately done locally rather than via the
// `Signer` port, mirroring how a real KMS/HSM works: only signing needs the
// vault, anyone holding the public key can verify.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";
import { Effect } from "effect";
import { SignerError, SignerTag } from "../services/Signer";

/**
 * `Signer` keyId for session tokens. Deliberately distinct from
 * `SshCaService`'s `SSH_CA_KEY_ID` — see that file's comment for why "the
 * same Key Vault sign operation" is read as "the same port/mechanism", not
 * literally the same key.
 */
export const SESSION_TOKEN_KEY_ID = "session-token";

/**
 * Short-lived: this token only authorizes the *handshake* — attaching to a
 * session — not the session's duration. 15 minutes is generous for a user
 * to click through to a waiting terminal without being so long-lived that a
 * leaked token is useful much after the fact.
 */
export const SESSION_TOKEN_TTL_SECONDS = 15 * 60;

export type SessionMethod = "terminal" | "ssh";

export interface MintSessionTokenInput {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: SessionMethod;
}

export interface MintedSessionToken {
  token: string;
  expiresAt: Date;
}

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

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const fromBase64Url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Mints a signed session token. Format: `<base64url claims>.<base64url
 * signature>` — the signature covers the exact bytes of the claims segment
 * string (not a re-serialization of the parsed JSON), so verification never
 * has to worry about canonicalization mismatches.
 */
export const mintSessionToken = (
  input: MintSessionTokenInput,
): Effect.Effect<MintedSessionToken, SignerError, SignerTag> =>
  Effect.gen(function* () {
    const signer = yield* SignerTag;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TOKEN_TTL_SECONDS * 1000);

    const claims: RawClaims = {
      idpIdentity: input.idpIdentity,
      targetMachineId: input.targetMachineId,
      targetOsUser: input.targetOsUser,
      method: input.method,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const claimsSegment = toBase64Url(utf8(JSON.stringify(claims)));
    const signature = yield* signer.sign({
      keyId: SESSION_TOKEN_KEY_ID,
      algorithm: "ed25519",
      data: utf8(claimsSegment),
    });

    return { token: `${claimsSegment}.${toBase64Url(signature)}`, expiresAt };
  });

/**
 * Verifies a session token's signature and expiry. This is the exact check
 * the tunnel daemon must run "on every session, including under load" (spec
 * §11.1) before attaching a terminal — there is no code path here that
 * returns claims without a passing signature check first, including for
 * expired tokens (an expired-but-validly-signed token still fails, but only
 * *after* the signature is confirmed genuine — an attacker must not be able
 * to learn anything, including "the claims were well-formed", from an
 * unsigned or mis-signed token).
 *
 * `keyId` is fixed to `SESSION_TOKEN_KEY_ID` rather than read from the
 * token itself, deliberately — trusting an attacker-supplied key
 * identifier to pick which key to verify against is a classic
 * signature-confusion bug class.
 */
export const verifySessionToken = (
  token: string,
): Effect.Effect<SessionClaims, SignerError, SignerTag> =>
  Effect.gen(function* () {
    const signer = yield* SignerTag;

    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return yield* Effect.fail(
        new SignerError({ reason: "malformed", cause: "expected `<claims>.<signature>`" }),
      );
    }
    const [claimsSegment, signatureSegment] = parts as [string, string];

    const publicKeyDer = yield* signer.publicKey(SESSION_TOKEN_KEY_ID);
    const publicKey = yield* Effect.try({
      try: () =>
        crypto.createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" }),
      catch: (cause) => new SignerError({ reason: "malformed_key", cause }),
    });

    // Plain try/catch (not `Effect.try`, whose `catch` maps into the *error* channel): a
    // malformed signature segment throwing and a well-formed-but-wrong signature both mean
    // "not valid" — a success value of `false`, not a distinct effect failure.
    const signatureValid = yield* Effect.sync(() => {
      try {
        return crypto.verify(
          null,
          Buffer.from(utf8(claimsSegment)),
          publicKey,
          Buffer.from(fromBase64Url(signatureSegment)),
        );
      } catch {
        return false;
      }
    });
    if (!signatureValid) {
      return yield* Effect.fail(new SignerError({ reason: "invalid_signature" }));
    }

    // Only decode/trust claims content once the signature over those exact bytes is confirmed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(claimsSegment)));
    } catch (cause) {
      return yield* Effect.fail(new SignerError({ reason: "malformed", cause }));
    }
    if (!isRawClaims(parsed)) {
      return yield* Effect.fail(
        new SignerError({ reason: "malformed", cause: "unexpected claim shape" }),
      );
    }

    const expiresAt = new Date(parsed.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return yield* Effect.fail(new SignerError({ reason: "expired" }));
    }

    return {
      idpIdentity: parsed.idpIdentity,
      targetMachineId: parsed.targetMachineId,
      targetOsUser: parsed.targetOsUser,
      method: parsed.method,
      issuedAt: new Date(parsed.issuedAt),
      expiresAt,
    } satisfies SessionClaims;
  });
