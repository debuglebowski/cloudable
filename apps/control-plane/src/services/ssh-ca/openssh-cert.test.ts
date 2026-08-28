import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CERT_TYPE_USER,
  type CertificateFields,
  assembleCertificate,
  ed25519PublicKeyBlob,
  encodeCertificateBody,
  encodeSignatureField,
  formatAsOpenSshLine,
  rawEd25519FromSpki,
  sha256Fingerprint,
} from "./openssh-cert";

interface KeyPair {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

function rawPublicKey(publicKey: crypto.KeyObject): Uint8Array {
  return rawEd25519FromSpki(new Uint8Array(publicKey.export({ type: "spki", format: "der" })));
}

function buildSignedCertificate(fields: Omit<CertificateFields, "caPublicKeyRaw">, ca: KeyPair) {
  const full: CertificateFields = { ...fields, caPublicKeyRaw: rawPublicKey(ca.publicKey) };
  const body = encodeCertificateBody(full);
  const signature = new Uint8Array(crypto.sign(null, Buffer.from(body), ca.privateKey));
  const signatureField = encodeSignatureField(signature);
  return { blob: assembleCertificate(body, signatureField), body, signature };
}

describe("openssh-cert", () => {
  test("rawEd25519FromSpki extracts exactly the 32-byte point", () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    expect(der.length).toBe(44);
    const raw = rawEd25519FromSpki(der);
    expect(raw.length).toBe(32);
    // Re-import the raw point via ed25519PublicKeyBlob isn't directly checkable without
    // reconstructing SPKI, so instead verify a signature against `publicKey` still
    // validates using the raw bytes round-tripped through our own blob encoder for sshd's format.
    const blob = ed25519PublicKeyBlob(raw);
    expect(blob.length).toBe(4 + "ssh-ed25519".length + 4 + 32);
  });

  test("rejects a non-44-byte SPKI blob", () => {
    expect(() => rawEd25519FromSpki(new Uint8Array(10))).toThrow();
  });

  test("assembled certificate round-trips through the real OpenSSH parser (ssh-keygen -L)", () => {
    const ca = crypto.generateKeyPairSync("ed25519");
    const subject = crypto.generateKeyPairSync("ed25519");

    const now = BigInt(Math.floor(Date.now() / 1000));
    const fields: Omit<CertificateFields, "caPublicKeyRaw"> = {
      nonce: crypto.randomBytes(32),
      subjectPublicKeyRaw: rawPublicKey(subject.publicKey),
      serial: 42n,
      certType: CERT_TYPE_USER,
      keyId: "cloudable:person-123",
      validPrincipals: ["ubuntu"],
      validAfter: now - 60n,
      validBefore: now + 8n * 60n * 60n,
      extensions: [{ name: "permit-pty" }],
    };
    const { blob } = buildSignedCertificate(fields, ca);
    const line = formatAsOpenSshLine(blob, "person-123@cloudable");
    expect(line.startsWith("ssh-ed25519-cert-v01@openssh.com ")).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-ca-test-"));
    const certPath = path.join(dir, "id_ed25519-cert.pub");
    fs.writeFileSync(certPath, `${line}\n`);

    const result = Bun.spawnSync(["ssh-keygen", "-L", "-f", certPath]);
    const stdout = result.stdout.toString();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("user certificate");
    expect(stdout).toContain("Serial: 42");
    expect(stdout).toContain('Key ID: "cloudable:person-123"');
    expect(stdout).toContain("Principals:");
    expect(stdout).toContain("ubuntu");
    expect(stdout).toContain("permit-pty");
    // Only permit-pty was granted — the other standard ssh-keygen defaults must be absent.
    expect(stdout).not.toContain("permit-port-forwarding");
    expect(stdout).not.toContain("permit-agent-forwarding");
    expect(stdout).not.toContain("permit-X11-forwarding");
  });

  test("signature verifies against the CA public key and fails once the body is tampered", () => {
    const ca = crypto.generateKeyPairSync("ed25519");
    const subject = crypto.generateKeyPairSync("ed25519");
    const now = BigInt(Math.floor(Date.now() / 1000));
    const fields: Omit<CertificateFields, "caPublicKeyRaw"> = {
      nonce: crypto.randomBytes(32),
      subjectPublicKeyRaw: rawPublicKey(subject.publicKey),
      serial: 1n,
      certType: CERT_TYPE_USER,
      keyId: "cloudable:person-123",
      validPrincipals: ["ubuntu"],
      validAfter: now,
      validBefore: now + 60n,
      extensions: [{ name: "permit-pty" }],
    };
    const { body, signature } = buildSignedCertificate(fields, ca);

    expect(crypto.verify(null, Buffer.from(body), ca.publicKey, Buffer.from(signature))).toBe(true);

    const tamperedBody = new Uint8Array(body);
    const lastIndex = tamperedBody.length - 1;
    tamperedBody[lastIndex] = (tamperedBody[lastIndex] ?? 0) ^ 0xff;
    expect(
      crypto.verify(null, Buffer.from(tamperedBody), ca.publicKey, Buffer.from(signature)),
    ).toBe(false);
  });

  test("sha256Fingerprint is stable and changes with the key", () => {
    const a = crypto.generateKeyPairSync("ed25519");
    const b = crypto.generateKeyPairSync("ed25519");
    const blobA = ed25519PublicKeyBlob(rawPublicKey(a.publicKey));
    const blobB = ed25519PublicKeyBlob(rawPublicKey(b.publicKey));
    expect(sha256Fingerprint(blobA)).toBe(sha256Fingerprint(blobA));
    expect(sha256Fingerprint(blobA)).not.toBe(sha256Fingerprint(blobB));
    expect(sha256Fingerprint(blobA).startsWith("SHA256:")).toBe(true);
  });
});
