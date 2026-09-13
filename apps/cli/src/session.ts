// ---------------------------------------------------------------------------
// Where `cloudable login` puts the API credential, and where every other
// command reads it from.
//
// This is a bearer token (`apps/control-plane/src/services/CliToken.ts`),
// not the BetterAuth session cookie it used to be. The CLI no longer signs
// in on its own at all: `login` gets the token and the SSH certificate from
// one browser sign-in, so there is one login, not two. See `login.ts`.
//
// Still deliberately separate from the certificate, which never lands here —
// that one lives in ssh-agent and never touches disk. Two credentials,
// because two different things verify them: this token is checked by the
// control plane on every call, the certificate is checked by sshd on the
// machine with nothing to call. One command, though.
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StoredSession {
  token: string;
  email: string;
}

/** `CLOUDABLE_HOME` overrides where the session file lives — same convention as
 * `KUBECONFIG`/`AWS_CONFIG_FILE` in other CLIs, and how tests isolate this from
 * the real `~/.cloudable` without a mocking framework. */
function sessionPath(): string {
  const base = process.env.CLOUDABLE_HOME ?? path.join(os.homedir(), ".cloudable");
  return path.join(base, "session.json");
}

export function saveSession(session: StoredSession): void {
  const filePath = sessionPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 0o600: this file holds a live API credential — same care as an SSH private key.
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
}

/**
 * `CLOUDABLE_TOKEN` wins over the file. This is the headless path: CI has no
 * browser to complete a sign-in with, and the alternative used to be handing
 * the CLI an email and password, which is exactly what `login` stopped doing.
 * The email is unknown in this case and nothing needs it — `whoami` asks the
 * control plane rather than reading it from here.
 */
export function loadSession(): StoredSession | undefined {
  const fromEnv = process.env.CLOUDABLE_TOKEN;
  if (fromEnv) return { token: fromEnv, email: "(CLOUDABLE_TOKEN)" };

  try {
    const raw = fs.readFileSync(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.token !== "string" || typeof parsed.email !== "string") return undefined;
    return { token: parsed.token, email: parsed.email };
  } catch {
    return undefined;
  }
}

export function clearSession(): void {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    // Nothing to clear — already logged out.
  }
}

/** Requires a stored session, throwing a clear, actionable error if there isn't one. */
export function requireSession(): StoredSession {
  const session = loadSession();
  if (!session) {
    throw new Error("Not logged in — run `cloudable login` first.");
  }
  return session;
}
