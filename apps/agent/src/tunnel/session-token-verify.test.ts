import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import {
  type SessionClaims,
  SessionTokenVerificationError,
  clearCachedSessionTokenPublicKey,
  getSessionTokenPublicKey,
  verifySessionToken,
} from "./session-token-verify";

// This test mints tokens locally with `node:crypto` rather than importing
// `apps/control-plane/src/tunnel/session-token.ts`'s `mintSessionToken` —
// the agent must never import control-plane source (see `wire-types.ts`'s
// banner comment) — but reproduces its exact wire format byte for byte:
// `<base64url claims>.<base64url signature>`, where the signature covers
// the raw bytes of the claims segment *string*, not a re-serialization of
// the parsed JSON.
const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface RawClaims {
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: "terminal" | "ssh";
  issuedAt: string;
  expiresAt: string;
}

const baseClaims: RawClaims = {
  idpIdentity: "kalle@normain.com",
  targetMachineId: "machine-1",
  targetOsUser: "ubuntu",
  method: "terminal",
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
};

function generateSigningKeys(): { publicKeyDer: Uint8Array; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyDer: new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    privateKey,
  };
}

function mintToken(claims: RawClaims, privateKey: crypto.KeyObject): string {
  const claimsSegment = toBase64Url(utf8(JSON.stringify(claims)));
  const signature = crypto.sign(null, Buffer.from(utf8(claimsSegment)), privateKey);
  return `${claimsSegment}.${toBase64Url(signature)}`;
}

describe("verifySessionToken", () => {
  test("a freshly minted, validly signed token verifies and round-trips the claims", () => {
    const { publicKeyDer, privateKey } = generateSigningKeys();
    const token = mintToken(baseClaims, privateKey);

    const claims = verifySessionToken(token, publicKeyDer);

    expect(claims.idpIdentity).toBe(baseClaims.idpIdentity);
    expect(claims.targetMachineId).toBe(baseClaims.targetMachineId);
    expect(claims.targetOsUser).toBe(baseClaims.targetOsUser);
    expect(claims.method).toBe(baseClaims.method);
    expect(claims.expiresAt.toISOString()).toBe(baseClaims.expiresAt);
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // REQUIRED FAILURE PATH (spec §11.1 / this unit's brief): a tampered-signature token
  // must be refused. Valid claims, valid expiry, wrong signature.
  test("REQUIRED FAILURE PATH: a token with a tampered signature is refused", () => {
    const { publicKeyDer, privateKey } = generateSigningKeys();
    const token = mintToken(baseClaims, privateKey);
    const [claimsSegment, signatureSegment] = token.split(".") as [string, string];

    // Flip one bit in the signature segment's decoded bytes, re-encode.
    const sigBytes = Buffer.from(signatureSegment, "base64url");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    const tamperedToken = `${claimsSegment}.${sigBytes.toString("base64url")}`;

    let error: unknown;
    try {
      verifySessionToken(tamperedToken, publicKeyDer);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("invalid_signature");
  });

  // REQUIRED FAILURE PATH: an attacker who tampers with the claims (e.g. escalating
  // `targetOsUser` to "root") but keeps the original signature must be refused — the
  // signature covers the exact claims bytes, so any mutation invalidates it.
  test("REQUIRED FAILURE PATH: tampering with the claims (leaving the old signature) is refused", () => {
    const { publicKeyDer, privateKey } = generateSigningKeys();
    const token = mintToken(baseClaims, privateKey);
    const [claimsSegment, signatureSegment] = token.split(".") as [string, string];

    const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"));
    claims.targetOsUser = "root"; // privilege-escalation attempt via claim tampering
    const forgedClaimsSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const forgedToken = `${forgedClaimsSegment}.${signatureSegment}`;

    let error: unknown;
    try {
      verifySessionToken(forgedToken, publicKeyDer);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("invalid_signature");
  });

  // REQUIRED FAILURE PATH: a well-signed but expired token is refused — but ordering
  // matters here. This token's signature is genuinely valid over its (stale) claims, so
  // getting `reason: "expired"` (rather than some earlier rejection) proves the signature
  // check ran and passed *before* expiry was even inspected.
  test("a well-signed but expired token is refused only after the signature checks out", () => {
    const { publicKeyDer, privateKey } = generateSigningKeys();
    const expiredClaims: RawClaims = {
      ...baseClaims,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(), // already expired
    };
    const token = mintToken(expiredClaims, privateKey);

    let error: unknown;
    try {
      verifySessionToken(token, publicKeyDer);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("expired");
  });

  // ORDERING, asserted explicitly: take that same expired token and ALSO tamper its
  // signature. If expiry were checked before (or instead of) the signature, this would
  // report "expired" — it must report "invalid_signature" instead, proving the signature
  // gate runs first and an attacker learns nothing ("well-formed", "expired", etc.) about
  // an unsigned or mis-signed token's claims.
  test("REQUIRED ORDERING: an expired token with a tampered signature fails on signature, not expiry", () => {
    const { publicKeyDer, privateKey } = generateSigningKeys();
    const expiredClaims: RawClaims = {
      ...baseClaims,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const token = mintToken(expiredClaims, privateKey);
    const [claimsSegment, signatureSegment] = token.split(".") as [string, string];
    const sigBytes = Buffer.from(signatureSegment, "base64url");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    const tamperedExpiredToken = `${claimsSegment}.${sigBytes.toString("base64url")}`;

    let error: unknown;
    try {
      verifySessionToken(tamperedExpiredToken, publicKeyDer);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("invalid_signature");
  });

  // REQUIRED FAILURE PATH: a malformed token (no `<claims>.<signature>` separator) is refused.
  test("a malformed token (no separator) is refused", () => {
    const { publicKeyDer } = generateSigningKeys();

    let error: unknown;
    try {
      verifySessionToken("not-a-token", publicKeyDer);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("malformed");
  });

  test("claims signed with one key do not verify against a different key", () => {
    const { privateKey } = generateSigningKeys();
    const { publicKeyDer: otherPublicKeyDer } = generateSigningKeys();
    const token = mintToken(baseClaims, privateKey);

    let error: unknown;
    try {
      verifySessionToken(token, otherPublicKeyDer);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("invalid_signature");
  });

  test("a malformed public key is refused with reason `malformed_key`, not a thrown crash", () => {
    const { privateKey } = generateSigningKeys();
    const token = mintToken(baseClaims, privateKey);
    const notAKey = new Uint8Array([1, 2, 3, 4]);

    let error: unknown;
    try {
      verifySessionToken(token, notAKey);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionTokenVerificationError);
    expect((error as SessionTokenVerificationError).reason).toBe("malformed_key");
  });

  test("verified claims type-check as SessionClaims", () => {
    const { publicKeyDer, privateKey } = generateSigningKeys();
    const token = mintToken(baseClaims, privateKey);

    const claims: SessionClaims = verifySessionToken(token, publicKeyDer);
    expect(claims.issuedAt).toBeInstanceOf(Date);
  });
});

// `getSessionTokenPublicKey`'s caching/de-dup/decoding logic, exercised via its injectable
// `fetchPublicKey` parameter rather than a real HTTP call: `apiRequest`/`config.ts` read
// `CONTROL_PLANE_URL` once, frozen at first import, and `bun test` runs every file in this
// package in one shared process — a real-server version of this test would pass or fail
// depending on which other test file (e.g. `config.test.ts`) happened to freeze that value
// first. Injecting a stub sidesteps that entirely and keeps this test about this function's
// own logic, not `config.ts`'s process-wide state.
describe("getSessionTokenPublicKey", () => {
  let requestCount = 0;
  const derBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const derBase64 = Buffer.from(derBytes).toString("base64");

  const fakeFetchPublicKey = async () => {
    requestCount++;
    return { keyId: "session-token", publicKeyDerBase64: derBase64 };
  };

  afterEach(() => {
    clearCachedSessionTokenPublicKey();
    requestCount = 0;
  });

  test("fetches the public key and decodes it from base64", async () => {
    const key = await getSessionTokenPublicKey(fakeFetchPublicKey);
    expect(key).toEqual(derBytes);
    expect(requestCount).toBe(1);
  });

  test("caches the result — a second call does not refetch", async () => {
    await getSessionTokenPublicKey(fakeFetchPublicKey);
    await getSessionTokenPublicKey(fakeFetchPublicKey);
    expect(requestCount).toBe(1);
  });

  test("clearCachedSessionTokenPublicKey forces the next call to refetch", async () => {
    await getSessionTokenPublicKey(fakeFetchPublicKey);
    clearCachedSessionTokenPublicKey();
    await getSessionTokenPublicKey(fakeFetchPublicKey);
    expect(requestCount).toBe(2);
  });

  // REQUIRED per this unit's thundering-herd concern (spec §11.1, "under load"): two callers
  // racing in before anything is cached must share one outstanding request, not fire two.
  test("concurrent callers before the first fetch resolves share one in-flight request", async () => {
    const [first, second] = await Promise.all([
      getSessionTokenPublicKey(fakeFetchPublicKey),
      getSessionTokenPublicKey(fakeFetchPublicKey),
    ]);
    expect(first).toEqual(derBytes);
    expect(second).toEqual(derBytes);
    expect(requestCount).toBe(1);
  });
});
