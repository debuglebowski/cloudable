// ---------------------------------------------------------------------------
// Raw Ed25519 key material helpers for `cloudable login`'s ephemeral session
// keypair. `login.ts` generates a fresh keypair per login (living only as
// long as the ~8h certificate does) and needs the raw 32-byte point/seed
// forms both the control plane's SSH CA (see
// `apps/control-plane/src/services/ssh-ca/openssh-cert.ts`) and the
// ssh-agent wire protocol (`ssh-agent-client.ts`) expect — Node's
// `node:crypto` only exposes SPKI/PKCS8 DER, so this file extracts the raw
// bytes from that fixed-format DER. Never touches anyone else's key
// material — this is the CLI's own ephemeral, locally-generated key, not
// the CA's.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";

export interface RawEd25519KeyPair {
  /** 32-byte raw Ed25519 public key point. */
  publicKeyRaw: Uint8Array;
  /** 32-byte raw Ed25519 private seed/scalar (NOT the 64-byte ssh-agent "sk" form — see `ssh-agent-client.ts`). */
  privateKeySeed: Uint8Array;
}

/**
 * Ed25519 SubjectPublicKeyInfo (RFC 8410) has a fixed, parameter-free DER
 * layout: a 12-byte header followed by exactly the 32-byte raw point, so
 * the raw key is always the last 32 bytes of a 44-byte SPKI DER blob.
 */
export function rawPublicKeyFromSpki(spkiDer: Uint8Array): Uint8Array {
  if (spkiDer.length !== 44) {
    throw new Error(`expected a 44-byte Ed25519 SPKI DER blob, got ${spkiDer.length} bytes`);
  }
  return spkiDer.slice(12);
}

/**
 * Ed25519 PKCS8 (RFC 8410) is equally fixed: a 16-byte header (outer
 * SEQUENCE, version, algorithm SEQUENCE, and the doubly-nested OCTET
 * STRING that wraps the raw seed — OpenSSL/Node deviate from some other
 * ed25519 tooling by nesting an extra OCTET STRING here) followed by
 * exactly the 32-byte seed, for a fixed 48-byte total.
 */
export function rawSeedFromPkcs8(pkcs8Der: Uint8Array): Uint8Array {
  if (pkcs8Der.length !== 48) {
    throw new Error(`expected a 48-byte Ed25519 PKCS8 DER blob, got ${pkcs8Der.length} bytes`);
  }
  return pkcs8Der.slice(16);
}

export function generateRawEd25519KeyPair(): RawEd25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyRaw: rawPublicKeyFromSpki(
      new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    ),
    privateKeySeed: rawSeedFromPkcs8(
      new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })),
    ),
  };
}
