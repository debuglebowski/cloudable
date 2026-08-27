import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { ed25519SpkiDerToJwk } from "./jwk";

describe("ed25519SpkiDerToJwk", () => {
  test("converts an Ed25519 public key's SPKI DER into a well-formed OKP JWK", () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

    const jwk = ed25519SpkiDerToJwk(der, "test-kid");

    expect(jwk).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: jwk.x,
      use: "sig",
      alg: "EdDSA",
      kid: "test-kid",
    });
    // Ed25519 public keys are 32 raw bytes.
    expect(Buffer.from(jwk.x, "base64url").length).toBe(32);
  });

  test("round-trips: the JWK's x value reconstructs a key that verifies a signature made by the matching private key", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const jwk = ed25519SpkiDerToJwk(der, "test-kid");

    const reconstructed = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      format: "jwk",
    });

    const data = Buffer.from("hello federation");
    const signature = crypto.sign(null, data, privateKey);
    expect(crypto.verify(null, data, reconstructed, signature)).toBe(true);
  });
});
