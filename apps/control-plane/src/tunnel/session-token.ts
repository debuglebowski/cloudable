// ---------------------------------------------------------------------------
// Signed session tokens: the control plane mints a short-lived
// token carrying IdP identity, target machine and target OS user, signed
// via the same Key Vault sign operation as the SSH CA. The agent validates
// the signature before attaching.
//
// This file only ever calls `Signer.sign()` / `Signer.publicKey()` — it
// never generates or holds key material itself.
// The actual signature check (`@cloudable/session-token`) runs against the
// CA's PUBLIC key only (returned by `Signer.publicKey()`), which is not
// sensitive material — verification is deliberately done locally rather
// than via the `Signer` port, mirroring how a real KMS/HSM works: only
// signing needs the vault, anyone holding the public key can verify.
// ---------------------------------------------------------------------------
import {
  type SessionClaims,
  type SessionMethod,
  verifySessionToken as verifySessionTokenPure,
} from "@cloudable/session-token";
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

/**
 * Re-exported from `@cloudable/session-token` rather than redeclared. This used to be a
 * second, independent copy of the same union; the daemon verifies tokens against the
 * package's definition, so a copy that drifted would mean the control plane minting a
 * `method` the daemon's own claims guard rejects as malformed — a whole class of session
 * that fails only on the machine, after the token is already signed and persisted.
 */
export type { SessionMethod } from "@cloudable/session-token";

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

/**
 * Re-exported rather than redeclared, so this cannot drift from what the shared verifier
 * actually returns.
 *
 * Note the deliberate asymmetry with `MintSessionTokenInput` above, which keeps `method:
 * SessionMethod`: strict in what we sign, liberal in what we accept. The minter should only
 * ever be able to name a method this build knows; a verifier reading a token that may have
 * been signed by a newer control plane must be able to report what it found rather than
 * call it malformed. See `@cloudable/session-token`'s `RawClaims.method`.
 */
export type { SessionClaims } from "@cloudable/session-token";

/** What this file SIGNS. Strict on `method` on purpose — see `SessionClaims` above. */
interface RawClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: SessionMethod;
  issuedAt: string;
  expiresAt: string;
}

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
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
      algorithm: "ecdsa-sha2-nistp256",
      data: utf8(claimsSegment),
    });

    return { token: `${claimsSegment}.${toBase64Url(signature)}`, expiresAt };
  });

/**
 * Verifies a session token's signature and expiry. This is the exact check
 * the tunnel daemon must run "on every session, including under load"
 * before attaching a terminal — there is no code path here that
 * returns claims without a passing signature check first, including for
 * expired tokens (an expired-but-validly-signed token still fails, but only
 * *after* the signature is confirmed genuine — an attacker must not be able
 * to learn anything, including "the claims were well-formed", from an
 * unsigned or mis-signed token).
 *
 * This is a thin wrapper: `signer.publicKey()` is the only I/O (Key Vault
 * read), and the byte-level check itself lives in the pure, framework-free
 * `@cloudable/session-token` package — shared verbatim with the tunnel
 * daemon, which can't depend on `effect`/`SignerTag` (see that package's
 * header comment for why two copies of this logic would be a real risk).
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
    const publicKeyDer = yield* signer.publicKey(SESSION_TOKEN_KEY_ID);

    const result = verifySessionTokenPure(token, publicKeyDer);
    if (!result.ok) {
      return yield* Effect.fail(new SignerError({ reason: result.reason, cause: result.cause }));
    }
    return result.claims;
  });
