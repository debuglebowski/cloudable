import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { generateRawEd25519KeyPair, rawPublicKeyFromSpki, rawSeedFromPkcs8 } from "./ed25519-keys";

/** Rebuilds a full PKCS8 DER blob from just the 32-byte seed, using the same fixed header `rawSeedFromPkcs8` strips. */
function pkcs8FromRawSeed(seed: Uint8Array): Buffer {
  const header = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([header, Buffer.from(seed)]);
}

describe("ed25519-keys", () => {
  test("generateRawEd25519KeyPair returns exactly 32+32 bytes", () => {
    const pair = generateRawEd25519KeyPair();
    expect(pair.publicKeyRaw.length).toBe(32);
    expect(pair.privateKeySeed.length).toBe(32);
  });

  test("rejects non-44-byte SPKI and non-48-byte PKCS8 blobs", () => {
    expect(() => rawPublicKeyFromSpki(new Uint8Array(10))).toThrow();
    expect(() => rawSeedFromPkcs8(new Uint8Array(10))).toThrow();
  });

  // Empirical proof the 16-byte PKCS8 header offset is correct: rebuild a private key from
  // *only* the extracted seed and confirm it is bit-for-bit the same key OpenSSL generated —
  // same derived public key, and a signature it produces verifies against the original.
  test("REQUIRED CORRECTNESS CHECK: the extracted 32-byte seed round-trips to the exact same keypair", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const originalPublicRaw = rawPublicKeyFromSpki(
      new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    );
    const seed = rawSeedFromPkcs8(
      new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })),
    );

    const reconstructed = crypto.createPrivateKey({
      key: pkcs8FromRawSeed(seed),
      format: "der",
      type: "pkcs8",
    });

    // Same derived public key.
    const reconstructedPublicDer = new Uint8Array(
      crypto.createPublicKey(reconstructed).export({ type: "spki", format: "der" }),
    );
    expect(Buffer.from(rawPublicKeyFromSpki(reconstructedPublicDer))).toEqual(
      Buffer.from(originalPublicRaw),
    );

    // A signature from the reconstructed key verifies against the original public key.
    const message = Buffer.from("cloudable ssh agent identity round-trip check");
    const signature = crypto.sign(null, message, reconstructed);
    expect(crypto.verify(null, message, publicKey, signature)).toBe(true);
  });
});
