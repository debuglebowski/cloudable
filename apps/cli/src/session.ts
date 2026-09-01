// ---------------------------------------------------------------------------
// Local session storage for `cloudable auth login`/`machines *` — a real
// BetterAuth session cookie (see `apps/control-plane/src/auth.ts`), the same
// mechanism the console uses, just stored on disk instead of in a browser.
// Deliberately separate from `login.ts`'s SSH-certificate flow: that's a
// machine-access credential (an ssh-agent identity), this is an API-call
// credential (a session cookie) — different mechanisms for different things,
// not two competing auth systems.
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StoredSession {
  cookie: string;
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
  // 0o600: this file holds a live session cookie — same care as an SSH private key.
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function loadSession(): StoredSession | undefined {
  try {
    const raw = fs.readFileSync(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.cookie !== "string" || typeof parsed.email !== "string") return undefined;
    return { cookie: parsed.cookie, email: parsed.email };
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
    throw new Error("Not logged in — run `cloudable auth login` first.");
  }
  return session;
}
