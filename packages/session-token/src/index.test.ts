import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { type SessionClaims, verifySessionToken } from "./index";

// No `Signer` port here (this package doesn't depend on `effect` at all) — tests mint their
// own tokens with a plain in-memory ed25519 keypair, mirroring exactly what
// `apps/control-plane/src/tunnel/session-token.ts`'s `mintSessionToken` does against a real
// `Signer.sign()`.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyDer = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const baseClaims = {
  idpIdentity: "kalle@normain.com",
  targetMachineId: "machine-1",
  targetOsUser: "ubuntu",
  method: "terminal" as const,
};

function mint(
  overrides: Partial<Record<keyof typeof baseClaims | "issuedAt" | "expiresAt", string>> = {},
) {
  const now = new Date();
  const claims = {
    ...baseClaims,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    ...overrides,
  };
  const claimsSegment = toBase64Url(utf8(JSON.stringify(claims)));
  const signature = crypto.sign(null, Buffer.from(utf8(claimsSegment)), privateKey);
  return { token: `${claimsSegment}.${toBase64Url(signature)}`, claimsSegment };
}

describe("verifySessionToken (pure)", () => {
  test("a freshly minted token verifies and round-trips the claims", () => {
    const { token } = mint();
    const result = verifySessionToken(token, publicKeyDer);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const claims: SessionClaims = result.claims;
    expect(claims.idpIdentity).toBe(baseClaims.idpIdentity);
    expect(claims.targetMachineId).toBe(baseClaims.targetMachineId);
    expect(claims.targetOsUser).toBe(baseClaims.targetOsUser);
    expect(claims.method).toBe(baseClaims.method);
    expect(claims.issuedAt).toBeInstanceOf(Date);
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // REQUIRED FAILURE PATH (CLAUDE.md / docs/spec.md §25): a session token with a broken
  // signature must be refused. Valid claims, valid expiry, wrong signature.
  test("REQUIRED FAILURE PATH: a token with a tampered signature is refused", () => {
    const { token } = mint();
    const [claimsSegment, signatureSegment] = token.split(".") as [string, string];
    const sigBytes = Buffer.from(signatureSegment, "base64url");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    const tamperedToken = `${claimsSegment}.${sigBytes.toString("base64url")}`;

    const result = verifySessionToken(tamperedToken, publicKeyDer);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_signature");
  });

  test("REQUIRED FAILURE PATH: tampering with the claims (leaving the old signature) is refused", () => {
    const { token } = mint();
    const [claimsSegment, signatureSegment] = token.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"));
    claims.targetOsUser = "root"; // privilege-escalation attempt via claim tampering
    const forgedClaimsSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const forgedToken = `${forgedClaimsSegment}.${signatureSegment}`;

    const result = verifySessionToken(forgedToken, publicKeyDer);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_signature");
  });

  test("a well-signed but expired token is refused only after the signature checks out", () => {
    const { token } = mint({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const result = verifySessionToken(token, publicKeyDer);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
  });

  test("a malformed token (no separator) is refused", () => {
    const result = verifySessionToken("not-a-token", publicKeyDer);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("malformed");
  });

  test("claims signed with a different keypair do not verify against this public key", () => {
    const { token } = mint();
    const otherKeyPair = crypto.generateKeyPairSync("ed25519");
    const otherPublicKeyDer = new Uint8Array(
      otherKeyPair.publicKey.export({ format: "der", type: "spki" }),
    );

    const result = verifySessionToken(token, otherPublicKeyDer);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_signature");
  });

  test("a malformed public key is reported distinctly, not confused with a bad signature", () => {
    const { token } = mint();
    const result = verifySessionToken(token, new Uint8Array([1, 2, 3]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("malformed_key");
  });
});
