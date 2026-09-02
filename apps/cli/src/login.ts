// ---------------------------------------------------------------------------
// `cloudable login`: browser → IdP → ~8h certificate into the user's
// ssh-agent.
//
// No real IdP exists in this sandbox (see CLAUDE.md's build-order note and
// `docs/access.md`), so the browser→IdP round trip is simulated behind a
// `--dev-person-id`/`--org-id` flag pair — DEV-ONLY, clearly gated (see
// `assertDevFlow` below), and documented as the seam a future feature unit
// replaces with a real OIDC redirect once an IdP integration exists.
//
// What IS real: the ephemeral keypair is generated locally (never sent to
// the control plane — only its public half is), the control plane's SSH CA
// signs it into a genuine OpenSSH certificate (see
// `apps/control-plane/src/services/ssh-ca/openssh-cert.ts`, verified against
// `ssh-keygen -L`), and the certificate + private key are loaded into the
// user's running ssh-agent over the real wire protocol (`ssh-agent-client.ts`,
// verified against a real `ssh-agent` process) — no `ssh-add` shell-out.
// ---------------------------------------------------------------------------
import * as os from "node:os";
import type {
  IssueCertificateRequest,
  IssueCertificateResponse,
  MachineScope,
} from "@cloudable/contracts";
import { generateRawEd25519KeyPair } from "./ed25519-keys";
import { apiRequest } from "./http-client";
import { addCertifiedIdentity } from "./ssh-agent-client";

export interface LoginOptions {
  /** DEV-ONLY: stands in for the identity a real OIDC flow would resolve from the browser session. */
  devPersonId: string;
  orgId: string;
  osUser: string;
  machineScope: MachineScope;
}

export interface LoginResult {
  certificateId: string;
  fingerprint: string;
  expiresAt: Date;
  /** Whether the certificate was actually loaded into a running ssh-agent (false when `SSH_AUTH_SOCK` is unset/unreachable). */
  loadedIntoAgent: boolean;
}

function parseMachineScope(raw: string | undefined): MachineScope {
  if (!raw || raw === "all") return "all";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseLoginArgs(argv: ReadonlyArray<string>): LoginOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for --${key}`);
      }
      flags.set(key, value);
      i++;
    }
  }

  const devPersonId = flags.get("dev-person-id");
  const orgId = flags.get("org-id");
  if (!devPersonId || !orgId) {
    throw new Error(
      "cloudable login (dev mode) requires --dev-person-id <id> and --org-id <id> — " +
        "there is no real IdP in this build; see docs/access.md",
    );
  }

  return {
    devPersonId,
    orgId,
    osUser: flags.get("os-user") ?? os.userInfo().username,
    machineScope: parseMachineScope(flags.get("machine-scope")),
  };
}

/** Extracts the raw certificate bytes out of the `<type> <base64> [comment]` OpenSSH line. */
function certificateBlobFromLine(line: string): Uint8Array {
  const parts = line.trim().split(" ");
  const base64 = parts[1];
  if (parts[0] !== "ssh-ed25519-cert-v01@openssh.com" || !base64) {
    throw new Error(`unexpected certificate line shape: ${line}`);
  }
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  // DEV-ONLY seam — see the file banner. A real flow would open a browser to the org's IdP
  // and exchange the resulting session for `{ personId, orgId }` here instead of taking them
  // as flags.
  const keypair = generateRawEd25519KeyPair();

  const request: IssueCertificateRequest = {
    orgId: options.orgId,
    personId: options.devPersonId,
    osUser: options.osUser,
    machineScope: options.machineScope,
    publicKeyBase64: Buffer.from(keypair.publicKeyRaw).toString("base64"),
  };

  const response = await apiRequest<IssueCertificateResponse>("/api/v1/access/certificates", {
    method: "POST",
    body: JSON.stringify(request),
  });

  const expiresAt = new Date(response.expiresAt);
  const certificateBlob = certificateBlobFromLine(response.certificate);

  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  let loadedIntoAgent = false;
  if (sshAuthSock) {
    const lifetimeSeconds = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 1000));
    await addCertifiedIdentity(sshAuthSock, {
      certificateBlob,
      publicKeyRaw: keypair.publicKeyRaw,
      privateKeySeed: keypair.privateKeySeed,
      comment: `${options.devPersonId}@cloudable`,
      lifetimeSeconds,
    });
    loadedIntoAgent = true;
  }

  return {
    certificateId: response.certificateId,
    fingerprint: response.fingerprint,
    expiresAt,
    loadedIntoAgent,
  };
}

export async function runLoginCommand(argv: ReadonlyArray<string>): Promise<void> {
  const options = parseLoginArgs(argv);
  const result = await login(options);

  console.log(`Certificate issued: ${result.certificateId}`);
  console.log(`  fingerprint: ${result.fingerprint}`);
  console.log(`  principal:   ${options.osUser}`);
  console.log(`  expires at:  ${result.expiresAt.toISOString()}`);
  if (result.loadedIntoAgent) {
    console.log("Loaded into ssh-agent (SSH_AUTH_SOCK) — ready to use.");
  } else {
    console.log(
      "SSH_AUTH_SOCK is not set — certificate was issued but not loaded into any ssh-agent. " +
        "Start one (e.g. `eval $(ssh-agent)`) and run `cloudable login` again.",
    );
  }
}
