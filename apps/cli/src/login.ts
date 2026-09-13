// ---------------------------------------------------------------------------
// `cloudable login`: browser → IdP → ~8h certificate into the user's
// ssh-agent.
//
// The browser round trip is real now: this opens the system browser to the
// console's `/cli-auth` page, which (behind `root.tsx`'s usual session
// guard) may first detour through `/login` — email/password or, once an org
// has connected one, "Sign in with SSO" (SAML, see `apps/control-plane/src/
// services/IdpSsoService.ts`) — then back. `/cli-auth`, now signed in,
// mints a short-lived signed code (`POST /api/v1/cli-auth/code`) and
// redirects the browser to a `node:http` server this process is running on
// localhost, which is the only thing actually listening for the result.
//
// No more `--dev-person-id`/`--org-id` flags: those traded on the control
// plane accepting a client-supplied identity for `issueCertificate`
// directly, which is exactly the trust `code` replaces — bringing them back
// as a fallback would mean reopening that hole for anyone who passes them,
// not just local dev. Nothing in this repo's own tests/scripts invoked them
// programmatically, so nothing else depends on removing them. Local/sandbox
// testing without a real IdP still works end-to-end via email/password
// sign-in at `/login` — this flow doesn't care which method produced the
// session.
//
// What IS real regardless: the ephemeral keypair is generated locally
// (never sent to the control plane — only its public half is), the control
// plane's SSH CA signs it into a genuine OpenSSH certificate (see
// `apps/control-plane/src/services/ssh-ca/openssh-cert.ts`, verified against
// `ssh-keygen -L`), and the certificate + private key are loaded into the
// user's running ssh-agent over the real wire protocol (`ssh-agent-client.ts`,
// verified against a real `ssh-agent` process) — no `ssh-add` shell-out.
// ---------------------------------------------------------------------------
import * as childProcess from "node:child_process";
import * as http from "node:http";
import {
  type IssueCertificateRequest,
  type IssueCertificateResponse,
  MACHINE_OS_USER,
  type MachineScope,
} from "@cloudable/contracts";
import { config } from "./config";
import { generateRawEd25519KeyPair } from "./ed25519-keys";
import { CliError, EXIT } from "./errors";
import { apiRequest } from "./http-client";
import { currentIdentity } from "./identity";
import { saveSession } from "./session";
import { addCertifiedIdentity } from "./ssh-agent-client";

export interface LoginOptions {
  osUser: string;
  machineScope: MachineScope;
}

export interface LoginResult {
  certificateId: string;
  fingerprint: string;
  expiresAt: Date;
  /** Whether the certificate was actually loaded into a running ssh-agent (false when `SSH_AUTH_SOCK` is unset/unreachable). */
  loadedIntoAgent: boolean;
  email: string;
  tokenExpiresAt: Date;
}

function parseMachineScope(raw: string | undefined): MachineScope {
  if (!raw || raw === "all") return "all";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const LOGIN_FLAGS = new Set(["os-user", "machine-scope"]);

/** Every bad-argument message points at the same help, so nobody has to guess the flag names. */
function loginUsageError(problem: string): Error {
  return new Error(`${problem}\n\nRun \`cloudable login --help\` for the options.`);
}

export function parseLoginArgs(argv: ReadonlyArray<string>): LoginOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      throw loginUsageError(`cloudable login takes no positional arguments, got '${arg}'.`);
    }
    const key = arg.slice(2);
    if (!LOGIN_FLAGS.has(key)) {
      throw loginUsageError(`unknown option '${arg}' for \`cloudable login\`.`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw loginUsageError(`missing value for ${arg}.`);
    }
    flags.set(key, value);
    i++;
  }

  return {
    osUser: flags.get("os-user") ?? MACHINE_OS_USER,
    machineScope: parseMachineScope(flags.get("machine-scope")),
  };
}

/** Best-effort — if this fails (no GUI, unknown platform), the printed URL is the fallback; the local server still waits for the redirect either way. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    childProcess.spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Nothing to do — the caller already printed the URL.
  }
}

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Opens the browser to the console's `/cli-auth` page and waits for it to
 * redirect back to a `node:http` server on an OS-assigned localhost port —
 * the real replacement for the old `--dev-person-id`/`--org-id` flags (see
 * this file's header comment).
 */
async function obtainCliAuthCode(): Promise<string> {
  const state = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const code = url.searchParams.get("code");
      const receivedState = url.searchParams.get("state");
      const ok = code !== null && receivedState === state;

      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<title>cloudable login</title><body>Signed in — you can close this tab.</body>"
          : "<title>cloudable login</title><body>Something went wrong — go back to your terminal.</body>",
      );

      clearTimeout(timeout);
      server.close();
      if (ok && code) resolve(code);
      else reject(new Error("cli-auth callback missing code or state mismatch"));
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for sign-in in the browser."));
    }, CALLBACK_TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      if (!port) {
        clearTimeout(timeout);
        reject(new Error("failed to start local callback server"));
        return;
      }
      const url = `${config.apiUrl}/cli-auth?callbackPort=${port}&state=${state}`;
      console.log(`Opening your browser to sign in:\n  ${url}`);
      openBrowser(url);
    });
  });
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const keypair = generateRawEd25519KeyPair();
  const code = await obtainCliAuthCode();

  const request: IssueCertificateRequest = {
    code,
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

  // A control plane older than this CLI answers without a `token` — it
  // still has the two separate logins this replaced. Caught here, because
  // storing an empty session and letting the next call report "not logged
  // in" describes the user's situation as the exact opposite of what it is:
  // the browser sign-in worked and the certificate below was issued.
  if (typeof response.token !== "string" || response.token === "") {
    throw new CliError(
      [
        `${config.apiUrl} did not return an API token.`,
        "",
        "That control plane is older than this CLI, from before `cloudable login` replaced",
        "`cloudable auth login`. Your certificate was issued and loaded, so SSH access is",
        "unaffected; every other command needs the control plane updated to a build that",
        "returns one.",
      ].join("\n"),
      EXIT.conflict,
    );
  }

  // Two writes on purpose. The token has to be on disk before
  // `currentIdentity()` can use it to ask `/api/v1/me` who this is, and the
  // email is worth storing so `whoami --local` can answer without a round
  // trip. Nothing looks the caller up BY that email — the token carries a
  // person id — so the empty one in between is inert, not a half-session.
  //
  // Both writes land before the ssh-agent step, which is the part that can
  // fail on a box with no agent. Being signed in to the API should not depend
  // on whether this machine happens to run one.
  saveSession({ token: response.token, email: "" });
  const identity = await currentIdentity();
  saveSession({ token: response.token, email: identity.email });

  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  let loadedIntoAgent = false;
  if (sshAuthSock) {
    const lifetimeSeconds = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 1000));
    await addCertifiedIdentity(sshAuthSock, {
      certificateBlob,
      publicKeyRaw: keypair.publicKeyRaw,
      privateKeySeed: keypair.privateKeySeed,
      comment: `${options.osUser}@cloudable`,
      lifetimeSeconds,
    });
    loadedIntoAgent = true;
  }

  return {
    certificateId: response.certificateId,
    fingerprint: response.fingerprint,
    expiresAt,
    loadedIntoAgent,
    email: identity.email,
    tokenExpiresAt: new Date(response.tokenExpiresAt),
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

export async function runLoginCommand(argv: ReadonlyArray<string>): Promise<void> {
  const options = parseLoginArgs(argv);
  const result = await login(options);

  console.log(`Signed in as ${result.email}.`);
  console.log(`Certificate issued: ${result.certificateId}`);
  console.log(`  fingerprint: ${result.fingerprint}`);
  console.log(`  principal:   ${options.osUser}`);
  console.log(`  expires at:  ${result.expiresAt.toISOString()}`);
  if (result.loadedIntoAgent) {
    console.log("Loaded into ssh-agent (SSH_AUTH_SOCK) — ready to use.");
  } else {
    console.log(
      "SSH_AUTH_SOCK is not set — the certificate was issued but not loaded into any ssh-agent. " +
        "Every other command still works; for SSH, start an agent " +
        "(e.g. `eval $(ssh-agent)`) and run `cloudable login` again.",
    );
  }
}
