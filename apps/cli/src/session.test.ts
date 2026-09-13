import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearSession, loadSession, requireSession, saveSession } from "./session";

// `CLOUDABLE_HOME` isolates this from the real `~/.cloudable` — see
// `session.ts`'s own doc comment on why that env var exists. Read fresh on
// every call (not cached at import time), so setting it in `beforeEach` is
// enough — no module-reload trick needed.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudable-session-test-"));
  process.env.CLOUDABLE_HOME = tmpDir;
});

afterEach(() => {
  process.env.CLOUDABLE_HOME = undefined;
  process.env.CLOUDABLE_TOKEN = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("session", () => {
  test("loadSession returns undefined when nothing has been saved", () => {
    expect(loadSession()).toBeUndefined();
  });

  test("saveSession then loadSession round-trips, with 0600 permissions", () => {
    saveSession({ token: "cli-token.abc123", email: "priya@acme.com" });

    const loaded = loadSession();
    expect(loaded).toEqual({ token: "cli-token.abc123", email: "priya@acme.com" });

    const filePath = path.join(tmpDir, "session.json");
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("clearSession removes a saved session, and is a no-op when there isn't one", () => {
    saveSession({ token: "cli-token.abc123", email: "priya@acme.com" });
    expect(loadSession()).toBeDefined();

    clearSession();
    expect(loadSession()).toBeUndefined();

    // Calling it again with nothing left to clear must not throw.
    expect(() => clearSession()).not.toThrow();
  });

  test("requireSession throws a clear, actionable error when not logged in", () => {
    expect(() => requireSession()).toThrow(/cloudable login/);
  });

  test("loadSession returns undefined for a malformed session file rather than throwing", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "session.json"), "{ not valid json");
    expect(loadSession()).toBeUndefined();
  });

  test("CLOUDABLE_TOKEN is used when set, without a session file", () => {
    process.env.CLOUDABLE_TOKEN = "cli-token.from-ci";
    expect(loadSession()).toEqual({ token: "cli-token.from-ci", email: "(CLOUDABLE_TOKEN)" });
  });

  test("CLOUDABLE_TOKEN wins over a saved session, so CI is never silently the wrong account", () => {
    saveSession({ token: "cli-token.on-disk", email: "priya@acme.com" });
    process.env.CLOUDABLE_TOKEN = "cli-token.from-ci";
    expect(loadSession()?.token).toBe("cli-token.from-ci");
  });

  test("loadSession returns undefined when the stored shape is missing fields", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "session.json"), JSON.stringify({ token: "only-a-token" }));
    expect(loadSession()).toBeUndefined();
  });
});
