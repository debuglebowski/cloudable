// Validates `addCertifiedIdentity` against a *real* `ssh-agent` process and a *real* OpenSSH
// certificate produced by `ssh-keygen -s` — the same rigor as
// `apps/control-plane/src/services/ssh-ca/openssh-cert.test.ts`, which validates the
// certificate bytes themselves against `ssh-keygen -L`. Skips itself if `ssh-agent`/`ssh-keygen`
// aren't on PATH (e.g. a minimal container image) rather than failing the whole suite.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateRawEd25519KeyPair } from "./ed25519-keys";
import { addCertifiedIdentity } from "./ssh-agent-client";

function sshToolsAvailable(): boolean {
  return (
    Bun.spawnSync(["which", "ssh-agent"]).exitCode === 0 &&
    Bun.spawnSync(["which", "ssh-keygen"]).exitCode === 0 &&
    Bun.spawnSync(["which", "ssh-add"]).exitCode === 0
  );
}

function sshWireEncodedPublicKey(rawPublicKey: Uint8Array): Buffer {
  const typeName = Buffer.from("ssh-ed25519", "utf8");
  const lenPrefixed = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([lenPrefixed(typeName), lenPrefixed(Buffer.from(rawPublicKey))]);
}

describe.if(sshToolsAvailable())("addCertifiedIdentity (against a real ssh-agent)", () => {
  let dir: string;
  let sockPath: string;
  let agentProc: ReturnType<typeof Bun.spawn> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudable-ssha-"));
    // Unix domain sockets have a short path limit (~104 bytes on macOS) — use /tmp directly
    // rather than the (much longer) mkdtemp path for the socket file itself.
    sockPath = `/tmp/cloudable-test-${process.pid}-${Date.now()}.sock`;
    agentProc = undefined;
  });

  afterEach(() => {
    agentProc?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sockPath, { force: true });
  });

  test("a certified identity added via our hand-rolled protocol client is accepted and reported back correctly", async () => {
    // 1. Our ephemeral "user" keypair (exactly what `login.ts` generates).
    const user = generateRawEd25519KeyPair();
    const pubLine = `ssh-ed25519 ${sshWireEncodedPublicKey(user.publicKeyRaw).toString("base64")} test-user\n`;
    const pubPath = path.join(dir, "id_ed25519.pub");
    fs.writeFileSync(pubPath, pubLine);

    // 2. A real CA keypair and a real `ssh-keygen -s` signature over our public key.
    const caPath = path.join(dir, "ca_key");
    const keygen = Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-f", caPath, "-N", "", "-q"]);
    expect(keygen.exitCode).toBe(0);

    const sign = Bun.spawnSync([
      "ssh-keygen",
      "-s",
      caPath,
      "-I",
      "cloudable:test-person",
      "-n",
      "ubuntu",
      "-V",
      "+1h",
      pubPath,
    ]);
    expect(sign.exitCode).toBe(0);

    const certLine = fs.readFileSync(path.join(dir, "id_ed25519-cert.pub"), "utf8").trim();
    const [certType, certBase64] = certLine.split(" ");
    expect(certType).toBe("ssh-ed25519-cert-v01@openssh.com");
    const certificateBlob = new Uint8Array(Buffer.from(certBase64 ?? "", "base64"));

    // 3. A real ssh-agent process.
    agentProc = Bun.spawn(["ssh-agent", "-D", "-a", sockPath], {
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 50 && !fs.existsSync(sockPath); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(sockPath)).toBe(true);

    // 4. Our client adds the certified identity.
    await addCertifiedIdentity(sockPath, {
      certificateBlob,
      publicKeyRaw: user.publicKeyRaw,
      privateKeySeed: user.privateKeySeed,
      comment: "cloudable-test",
      lifetimeSeconds: 300,
    });

    // 5. The real agent reports it back as a certificate, not a bare key.
    const list = Bun.spawnSync(["ssh-add", "-L"], {
      env: { ...process.env, SSH_AUTH_SOCK: sockPath },
    });
    expect(list.exitCode).toBe(0);
    const listed = list.stdout.toString();
    expect(listed.startsWith("ssh-ed25519-cert-v01@openssh.com ")).toBe(true);
    expect(listed).toContain("cloudable-test");

    const fingerprints = Bun.spawnSync(["ssh-add", "-l"], {
      env: { ...process.env, SSH_AUTH_SOCK: sockPath },
    });
    expect(fingerprints.exitCode).toBe(0);
    expect(fingerprints.stdout.toString()).toContain("cloudable-test");
  });

  test("FAILURE PATH: an invalid public key length is rejected before anything touches the socket", async () => {
    const user = generateRawEd25519KeyPair();
    await expect(
      addCertifiedIdentity(sockPath, {
        certificateBlob: new Uint8Array([1, 2, 3]),
        publicKeyRaw: new Uint8Array(10), // not 32 bytes
        privateKeySeed: user.privateKeySeed,
        comment: "cloudable-test-bad-length",
      }),
    ).rejects.toThrow(/32-byte public key/);
  });

  test("FAILURE PATH: no agent listening on the socket path is refused, not silently accepted", async () => {
    // No `ssh-agent` spawned for this test — `sockPath` names nothing.
    const user = generateRawEd25519KeyPair();
    await expect(
      addCertifiedIdentity(sockPath, {
        certificateBlob: new Uint8Array([1, 2, 3]),
        publicKeyRaw: user.publicKeyRaw,
        privateKeySeed: user.privateKeySeed,
        comment: "cloudable-test-no-agent",
      }),
    ).rejects.toThrow();
  });
});
