/**
 * Minimal JWS/JWT compact-serialization helpers for the federation OIDC
 * issuer. Deliberately hand-rolled instead of pulling in a JWT library:
 * `alg: "EdDSA"` over Ed25519 is just "sign these exact bytes" (Ed25519
 * hashes internally, so there is no digest-then-sign step to get subtly
 * wrong), and the `Signer` port (see `../Signer.ts`) already exposes raw
 * sign/verify over arbitrary bytes — these functions are pure string/byte
 * plumbing around that port, no key material touched here.
 */

/** Standard claims every federation token carries (see `FederationService.ts`). */
export interface FederationClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

export interface FederationJwtHeader {
  readonly alg: "EdDSA";
  readonly typ: "JWT";
  readonly kid: string;
}

export const base64UrlEncode = (input: Uint8Array | string): string =>
  (typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input)).toString(
    "base64url",
  );

export const base64UrlDecode = (input: string): Buffer => Buffer.from(input, "base64url");

/** The two dot-joined, base64url-encoded segments that get signed — `base64url(header).base64url(payload)`. */
export const encodeSigningInput = (
  header: FederationJwtHeader,
  payload: FederationClaims,
): string =>
  `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;

/** Appends the base64url-encoded signature to a signing input to form the final compact JWS. */
export const assembleJws = (signingInput: string, signature: Uint8Array): string =>
  `${signingInput}.${base64UrlEncode(signature)}`;

export class MalformedJwtError extends Error {
  constructor(reason: string) {
    super(`malformed JWT: ${reason}`);
    this.name = "MalformedJwtError";
  }
}

/**
 * Decodes a compact JWS's payload segment as JSON, WITHOUT verifying the
 * signature. Used by the `FakeAzureTrustRule` test harness, which simulates
 * the *claims* check a customer's trust rule performs — not signature
 * cryptography (see `FakeAzureTrustRule.ts` for why that's in-scope for
 * this unit's canonical test and out of scope for real verification).
 */
export const decodeJwtPayloadUnsafe = (token: string): unknown => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new MalformedJwtError(`expected 3 dot-separated segments, got ${parts.length}`);
  }
  const [, payloadSegment] = parts;
  try {
    return JSON.parse(base64UrlDecode(payloadSegment as string).toString("utf8"));
  } catch (cause) {
    throw new MalformedJwtError(`payload segment is not valid JSON: ${String(cause)}`);
  }
};
