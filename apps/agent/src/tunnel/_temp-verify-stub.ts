// ---------------------------------------------------------------------------
// TEMPORARY STUB — delete this file once the sibling unit's
// `apps/agent/src/tunnel/session-token-verify.ts` lands (real signature
// verification, mirroring `apps/control-plane/src/tunnel/session-token.ts`'s
// `verifySessionToken` — see docs/access.md §3). That unit is being built in
// parallel, in its own worktree, and is expected to land around the same
// time as this one.
//
// To wire in the real module once it lands: in `client.ts`, change
//
//   import { verifySessionTokenLocally as verifySessionToken } from "./_temp-verify-stub";
//
// to
//
//   import { verifySessionToken } from "./session-token-verify";
//
// and delete this file — IF the real module also exposes the same async
// `(token: string) => Promise<SessionClaims>`-throws-on-any-failure shape as
// this stub (this unit's own brief's stated target, and the only shape
// apps/agent's zero-Effect convention — docs/spec.md §25 — can consume
// without pulling in `effect`). It is NOT simply this: control-plane's own
// `verifySessionToken` (apps/control-plane/src/tunnel/session-token.ts)
// returns `Effect.Effect<SessionClaims, SignerError, SignerTag>`, requiring a
// `Signer` context this agent has no layer for anywhere — if the sibling
// unit's module mirrors THAT shape verbatim instead, the swap needs a real
// adapter at the call site (at minimum `Effect.runPromise(...)`, plus
// translating `SignerError` into whatever shape callers here expect), not
// just a changed import path. Whoever does the final wiring should check
// which shape actually landed before assuming "one line."
//
// WHY A STUB AT ALL, AND NOT THE REAL CHECK: the byte-level signature check
// itself (`crypto.verify` against the CA's public key, exactly what
// `apps/control-plane/src/tunnel/session-token.ts` does) is that sibling
// unit's deliverable. Re-implementing it here would create exactly the "two
// independent copies of signature-verification logic" risk both units were
// told to avoid — one side could silently accept what the other would
// reject. So this file deliberately does NOT check the signature segment at
// all; it exists only so `client.ts`'s control flow (verify locally, before
// doing anything else — docs/spec.md §11.1) and this unit's own tests aren't
// blocked on a module living in a different worktree right now.
//
// It DOES enforce the same claims shape and expiry check the real
// implementation will, so tests exercising "malformed" / "expired" /
// "well-formed" tokens through `client.ts` stay meaningful after the swap —
// only the signature bytes themselves go unchecked here. `SessionClaims`/
// `RawClaims`/`isRawClaims` below are consequently a hand-copy of
// control-plane's own shape, not shared through `packages/contracts` — an
// accepted, temporary duplication (deliberately of a plain data shape, not
// of the security-sensitive signature check itself) that disappears the
// moment this file is deleted.
//
// NEVER wire this into anything beyond this unit's own tests or a manual dev
// check — it provides no real security. docs/spec.md §11.1's "the agent
// must validate the signature on every session, including under load" is
// NOT satisfied by this file. (See `client.ts`'s `TUNNEL_MANUAL_TRIGGER_ACK`
// for the deliberate three-factor gate this drives in practice.)
// ---------------------------------------------------------------------------

export type SessionMethod = "terminal" | "ssh";

/** Mirrors `apps/control-plane/src/tunnel/session-token.ts`'s `SessionClaims` exactly, so the
 * eventual swap to the real module is a type-compatible drop-in. */
export interface SessionClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: SessionMethod;
  issuedAt: Date;
  expiresAt: Date;
}

export class SessionTokenVerificationError extends Error {
  constructor(public readonly reason: "malformed" | "expired") {
    super(`session token verification failed: ${reason}`);
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
// Hoisted, not constructed per call — cheap either way for a once-per-connection check, but
// matches the same convention `client.ts` uses for its own (much hotter) per-message decoding.
const textDecoder = new TextDecoder();

/**
 * Stand-in for the sibling unit's real `verifySessionToken`: same async
 * `(token: string) => Promise<SessionClaims>` shape, throwing on any
 * failure, never resolving with claims for a token it hasn't fully accepted
 * by its own (deliberately incomplete — see file banner) rules.
 *
 * Checks the token is shaped like `<base64url claims>.<base64url
 * signature>`, that the claims segment decodes to the expected shape, and
 * that neither timestamp is malformed nor the token expired. Does NOT check
 * the signature segment against anything — that's the one piece left for
 * the real module.
 */
export async function verifySessionTokenLocally(token: string): Promise<SessionClaims> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new SessionTokenVerificationError("malformed");
  }
  const [claimsSegment] = parts as [string, string];
  // Deliberately unchecked: the signature segment. See file banner.

  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(fromBase64Url(claimsSegment)));
  } catch {
    throw new SessionTokenVerificationError("malformed");
  }
  if (!isRawClaims(parsed)) {
    throw new SessionTokenVerificationError("malformed");
  }

  const issuedAt = new Date(parsed.issuedAt);
  const expiresAt = new Date(parsed.expiresAt);
  // Both timestamps are validated as real dates before anything is trusted — `issuedAt` isn't
  // used for the expiry decision, but returning claims with an `Invalid Date` inside them would
  // still be handing a caller a silently-broken value.
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw new SessionTokenVerificationError("malformed");
  }
  if (expiresAt.getTime() < Date.now()) {
    throw new SessionTokenVerificationError("expired");
  }

  return {
    idpIdentity: parsed.idpIdentity,
    targetMachineId: parsed.targetMachineId,
    targetOsUser: parsed.targetOsUser,
    method: parsed.method,
    issuedAt,
    expiresAt,
  };
}
