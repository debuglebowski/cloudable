// ---------------------------------------------------------------------------
// A minimal ssh-agent protocol client: connects to `SSH_AUTH_SOCK` (a Unix
// domain socket) and sends a single `SSH_AGENTC_ADD_IDENTITY` /
// `SSH_AGENTC_ADD_ID_CONSTRAINED` message to load a certified identity —
// implemented directly against the wire protocol (RFC 9987 §5.2, §8) rather
// than shelling out to `ssh-add`, per this unit's brief. The message
// layout for a *certified* Ed25519 key (cert blob replacing the bare public
// key, private key fields unchanged) is not in the RFC — it's OpenSSH's own
// extension, confirmed against `sshkey.c`'s `sshkey_private_serialize_opt`
// and `ssh-ed25519.c`'s `ssh_ed25519_serialize_private`
// (openssh/openssh-portable), and empirically verified in
// `ssh-agent-client.test.ts` against a real `ssh-agent` process.
//
// Deliberately narrow: this only implements ADD_IDENTITY/ADD_ID_CONSTRAINED
// and reading the single-byte success/failure reply — not the full agent
// protocol (listing, signing, removal, extensions).
// ---------------------------------------------------------------------------
import { once } from "node:events";
import * as net from "node:net";

const SSH_AGENTC_ADD_IDENTITY = 17;
const SSH_AGENTC_ADD_ID_CONSTRAINED = 25;
const SSH_AGENT_CONSTRAIN_LIFETIME = 1;
const SSH_AGENT_SUCCESS = 6;
const SSH_AGENT_FAILURE = 5;

const CERT_KEY_TYPE = "ssh-ed25519-cert-v01@openssh.com";

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

function u32(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function str(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return concat(u32(bytes.length), bytes);
}

export interface AddCertifiedIdentityInput {
  /** The full OpenSSH certificate, as raw wire bytes (not the base64 `authorized_keys`-style text form). */
  certificateBlob: Uint8Array;
  /** 32-byte raw Ed25519 public key point of the certified key (must match the key certified inside `certificateBlob`). */
  publicKeyRaw: Uint8Array;
  /** 32-byte raw Ed25519 private seed of the same key. */
  privateKeySeed: Uint8Array;
  comment: string;
  /** If set, sent as an `SSH_AGENT_CONSTRAIN_LIFETIME` constraint so the agent forgets the identity on its own — sized to the certificate's own TTL. */
  lifetimeSeconds?: number;
}

/** Sends one length-prefixed request and returns the one length-prefixed response's payload. */
function requestResponse(socket: net.Socket, payload: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);

    const onError = (err: Error) => {
      socket.off("data", onData);
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const len = buffered.readUInt32BE(0);
      if (buffered.length < 4 + len) return;
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(new Uint8Array(buffered.subarray(4, 4 + len)));
    };

    socket.on("error", onError);
    socket.on("data", onData);
    socket.write(Buffer.from(concat(u32(payload.length), payload)));
  });
}

/**
 * Connects to `sockPath` (an `SSH_AUTH_SOCK`-style Unix domain socket) and
 * adds a certified Ed25519 identity, optionally lifetime-constrained.
 * Throws if the agent refuses (`SSH_AGENT_FAILURE`) or replies with
 * anything other than `SSH_AGENT_SUCCESS`.
 */
export async function addCertifiedIdentity(
  sockPath: string,
  input: AddCertifiedIdentityInput,
): Promise<void> {
  if (input.publicKeyRaw.length !== 32) {
    throw new Error(`expected a 32-byte public key, got ${input.publicKeyRaw.length} bytes`);
  }
  if (input.privateKeySeed.length !== 32) {
    throw new Error(`expected a 32-byte private seed, got ${input.privateKeySeed.length} bytes`);
  }

  const secretKey = concat(input.privateKeySeed, input.publicKeyRaw); // ssh-agent's "sk": seed(32) || pk(32)
  const constrained = typeof input.lifetimeSeconds === "number";

  const body = concat(
    Uint8Array.of(constrained ? SSH_AGENTC_ADD_ID_CONSTRAINED : SSH_AGENTC_ADD_IDENTITY),
    str(CERT_KEY_TYPE),
    str(input.certificateBlob),
    str(input.publicKeyRaw),
    str(secretKey),
    str(input.comment),
    ...(constrained
      ? [concat(Uint8Array.of(SSH_AGENT_CONSTRAIN_LIFETIME), u32(input.lifetimeSeconds as number))]
      : []),
  );

  const socket = net.createConnection(sockPath);
  try {
    await once(socket, "connect");
    const response = await requestResponse(socket, body);
    const code = response[0];
    if (code !== SSH_AGENT_SUCCESS) {
      throw new Error(
        code === SSH_AGENT_FAILURE
          ? "ssh-agent refused the identity (SSH_AGENT_FAILURE)"
          : `ssh-agent returned an unexpected response code: ${code ?? "<empty>"}`,
      );
    }
  } finally {
    socket.end();
  }
}
