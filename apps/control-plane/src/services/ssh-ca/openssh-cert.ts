// ---------------------------------------------------------------------------
// Pure OpenSSH certificate wire-format assembly (RFC 4251 §5 primitives,
// PROTOCOL.certkeys layout for `ssh-ed25519-cert-v01@openssh.com`). No key
// material is generated or held here — every function takes already-public
// bytes (a public key to certify, a CA public key, a signature produced
// elsewhere) and returns bytes. The actual signing happens through the
// `Signer` port in `SshCaService.ts`; this file only knows how to lay bytes
// out in the format sshd expects.
//
// Deliberately narrow extension set: only `permit-pty` is granted (no
// X11/agent/port forwarding) — this product brokers governed interactive
// access, not general tunneling: no general application hosting, and
// tunnels are outbound only, never inbound.
// ---------------------------------------------------------------------------

export const CERT_KEY_TYPE = "ssh-ed25519-cert-v01@openssh.com";
export const KEY_TYPE = "ssh-ed25519";
export const SIGNATURE_FORMAT = "ssh-ed25519";

/** OpenSSH certificate `type` field: 1 = user certificate, 2 = host certificate. */
export const CERT_TYPE_USER = 1;

export interface KeyValueOption {
  name: string;
  /** Present for options that carry an argument; omitted (empty) for boolean-style extensions like `permit-pty`. */
  data?: Uint8Array;
}

export interface CertificateFields {
  nonce: Uint8Array;
  /** Raw 32-byte Ed25519 point being certified — the user's ephemeral key, not the CA's. */
  subjectPublicKeyRaw: Uint8Array;
  serial: bigint;
  certType: typeof CERT_TYPE_USER;
  keyId: string;
  validPrincipals: ReadonlyArray<string>;
  validAfter: bigint;
  validBefore: bigint;
  criticalOptions?: ReadonlyArray<KeyValueOption>;
  extensions?: ReadonlyArray<KeyValueOption>;
  /** Raw 32-byte Ed25519 point of the CA — embedded so sshd/ssh-keygen can report it, not used for trust (trust comes from `TrustedUserCAKeys` naming the same key out of band). */
  caPublicKeyRaw: Uint8Array;
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeUint32(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function writeUint64(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, n, false);
  return buf;
}

function writeString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return concat(writeUint32(bytes.length), bytes);
}

function packOptions(options: ReadonlyArray<KeyValueOption>): Uint8Array {
  return concat(
    ...options
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((opt) => concat(writeString(opt.name), writeString(opt.data ?? new Uint8Array(0)))),
  );
}

/** The standard SSH wire-format public key blob: `string algo` + `string point`. */
export function ed25519PublicKeyBlob(rawPublicKey: Uint8Array): Uint8Array {
  return concat(writeString(KEY_TYPE), writeString(rawPublicKey));
}

/**
 * Encodes every certificate field up to (but excluding) the `signature`
 * field. This exact byte string is what the CA signs — sshd recomputes it
 * the same way to verify.
 */
export function encodeCertificateBody(fields: CertificateFields): Uint8Array {
  return concat(
    writeString(CERT_KEY_TYPE),
    writeString(fields.nonce),
    writeString(fields.subjectPublicKeyRaw),
    writeUint64(fields.serial),
    writeUint32(fields.certType),
    writeString(fields.keyId),
    writeString(concat(...fields.validPrincipals.map(writeString))),
    writeUint64(fields.validAfter),
    writeUint64(fields.validBefore),
    writeString(packOptions(fields.criticalOptions ?? [])),
    writeString(packOptions(fields.extensions ?? [])),
    writeString(new Uint8Array(0)), // reserved
    writeString(ed25519PublicKeyBlob(fields.caPublicKeyRaw)), // "signature key"
  );
}

/** Wraps a raw signature into the certificate's `signature` field: `string(string algo + string sig)`. */
export function encodeSignatureField(rawSignature: Uint8Array): Uint8Array {
  const signatureBlob = concat(writeString(SIGNATURE_FORMAT), writeString(rawSignature));
  return writeString(signatureBlob);
}

/** Concatenates the signed body with its signature field to produce the final certificate blob. */
export function assembleCertificate(body: Uint8Array, signatureField: Uint8Array): Uint8Array {
  return concat(body, signatureField);
}

/** Formats a certificate blob the way `ssh-keygen -s` / `authorized_keys` files do: `<type> <base64> <comment>`. */
export function formatAsOpenSshLine(certificateBlob: Uint8Array, comment: string): string {
  return `${CERT_KEY_TYPE} ${Buffer.from(certificateBlob).toString("base64")} ${comment}`;
}

/** `SHA256:<base64, no padding>` of a public key blob — the same format `ssh-keygen -lf` prints. */
export function sha256Fingerprint(publicKeyBlob: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256").update(publicKeyBlob).digest();
  return `SHA256:${Buffer.from(digest).toString("base64").replace(/=+$/, "")}`;
}

/**
 * Ed25519 SubjectPublicKeyInfo (RFC 8410) has a fixed, parameter-free DER
 * layout: a 12-byte header (outer + inner SEQUENCE, the Ed25519 OID, and the
 * BIT STRING header) followed by exactly the 32-byte raw point — so the raw
 * key is always the last 32 bytes of a 44-byte SPKI DER blob. Used to turn
 * `Signer.publicKey()`'s SPKI output into the raw point the cert format
 * needs; never touches private key material.
 */
export function rawEd25519FromSpki(spkiDer: Uint8Array): Uint8Array {
  if (spkiDer.length !== 44) {
    throw new Error(`expected a 44-byte Ed25519 SPKI DER blob, got ${spkiDer.length} bytes`);
  }
  return spkiDer.slice(12);
}
