// ---------------------------------------------------------------------------
// This file touches `node:crypto`, but only to parse the PUBLIC half of an
// Ed25519 keypair (the SPKI DER bytes `Signer.publicKey()` already returns)
// into JWK form for the `/.well-known/jwks.json` response. It never reads,
// imports, or exports a PRIVATE key, so it does not fall under CLAUDE.md
// invariant #9 / the "only two files touch raw key material" rule enforced
// by `Signer.local.ts` and `Signer.azure.ts` — those two remain the only
// files that ever hold a private key.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";

export interface Ed25519Jwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly use: "sig";
  readonly alg: "EdDSA";
  readonly kid: string;
}

/**
 * Converts an Ed25519 public key (SPKI DER, as returned by `Signer.publicKey()`)
 * into a JWK suitable for the JWKS document. Node's `KeyObject.export({
 * format: "jwk" })` already understands Ed25519/OKP keys, so this is just a
 * DER -> KeyObject -> JWK round-trip plus tagging the usage fields JWKS
 * consumers expect (`use`, `alg`, `kid`).
 */
export const ed25519SpkiDerToJwk = (der: Uint8Array, kid: string): Ed25519Jwk => {
  const keyObject = crypto.createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  const { x } = keyObject.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  return { kty: "OKP", crv: "Ed25519", x, use: "sig", alg: "EdDSA", kid };
};
