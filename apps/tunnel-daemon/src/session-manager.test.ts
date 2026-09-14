import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { spawnFilesSession } from "./files-session";
import { ApiError } from "./http-client";
import { spawnSession as realSpawnSession } from "./pty";
import {
  type SessionManagerDeps,
  createDefaultSessionManagerDeps,
  createSessionManager,
} from "./session-manager";
import { clearCachedSessionTokenPublicKey } from "./session-token-key";

// Real P-256 keypair, exactly like `packages/session-token`'s own test file — this
// exercises the real `@cloudable/session-token` verify logic, not a stub of it.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicKeyDer = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
const wrongKeyPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const wrongPublicKeyDer = new Uint8Array(
  wrongKeyPair.publicKey.export({ format: "der", type: "spki" }),
);

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function mintToken(
  overrides: {
    targetMachineId?: string;
    targetOsUser?: string;
    expiresAt?: string;
    signingKey?: crypto.KeyObject;
    method?: "terminal" | "ssh" | "files";
  } = {},
) {
  const now = new Date();
  const claims = {
    idpIdentity: "kalle@normain.com",
    targetMachineId: overrides.targetMachineId ?? "machine-1",
    targetOsUser: overrides.targetOsUser ?? "ubuntu",
    method: overrides.method ?? ("terminal" as const),
    issuedAt: now.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  };
  const claimsSegment = toBase64Url(utf8(JSON.stringify(claims)));
  const signature = crypto.sign("sha256", Buffer.from(utf8(claimsSegment)), {
    key: overrides.signingKey ?? privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${claimsSegment}.${toBase64Url(signature)}`;
}

/** Real `Bun.Terminal`-backed spawning (same as `pty.test.ts`), always forced through a
 * harmless unprivileged shell via `commandOverride` regardless of the verified
 * `targetOsUser` — these tests are exercising session-manager's dispatch/verification
 * logic, not the (separately flagged, unsolved) `su -<user>` privilege-drop step. */
const testSpawnSession: SessionManagerDeps["spawnSession"] = (options) =>
  realSpawnSession({ ...options, commandOverride: ["sh"] });

/** Same idea as `testSpawnSession`: a harmless unprivileged stand-in for the real
 * `su - <user> -c '<self> --fs-helper'`, so dispatch can be tested without root. `cat`
 * echoes whatever is written to it, which is enough to prove the plumbing is connected
 * without pulling a real helper process into these tests. */
const testSpawnFilesSession: SessionManagerDeps["spawnFilesSession"] = (options) =>
  spawnFilesSession({ ...options, commandOverride: ["cat"] });

/** The two file-session callbacks are irrelevant to every PTY test below, but the
 * interface requires them. Spread this rather than repeating two no-ops eleven times. */
const noFsCallbacks = { onFsResult: () => {}, onFsChunk: () => {} } as const;

function makeDeps(overrides: Partial<SessionManagerDeps> = {}): {
  deps: SessionManagerDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: SessionManagerDeps = {
    machineId: "machine-1",
    getSessionTokenPublicKeyBytes: async () => {
      calls.push("fetchKey");
      return publicKeyDer;
    },
    invalidateSessionTokenPublicKey: () => {
      calls.push("invalidate");
    },
    spawnSession: testSpawnSession,
    spawnFilesSession: testSpawnFilesSession,
    ...overrides,
  };
  return { deps, calls };
}

const waitFor = (predicate: () => boolean, timeoutMs = 5_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error("timed out waiting for condition"));
      setTimeout(check, 20);
    };
    check();
  });

describe("SessionManager", () => {
  let cleanupSessionIds: string[] = [];
  let manager: ReturnType<typeof createSessionManager> | undefined;

  beforeEach(() => {
    cleanupSessionIds = [];
  });

  afterEach(() => {
    for (const sessionId of cleanupSessionIds) manager?.close(sessionId);
  });

  test("a valid token for the right machine spawns a real PTY and returns ok", async () => {
    const { deps } = makeDeps();
    manager = createSessionManager(deps);
    cleanupSessionIds.push("s1");

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: true });
    expect(manager.has("s1")).toBe(true);
  });

  test("data() written to a live session echoes back through onData (real PTY I/O)", async () => {
    const { deps } = makeDeps();
    manager = createSessionManager(deps);
    cleanupSessionIds.push("s1");

    let output = "";
    await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      {
        onData: (bytes) => {
          output += new TextDecoder().decode(bytes);
        },
        onExit: () => {},
        ...noFsCallbacks,
      },
    );

    manager.data("s1", new TextEncoder().encode("echo SESSION_MANAGER_OK\n"));
    await waitFor(() => output.includes("SESSION_MANAGER_OK"));
    expect(output).toContain("SESSION_MANAGER_OK");
  });

  test("resize() actually changes the real PTY's termios size", async () => {
    const { deps } = makeDeps();
    manager = createSessionManager(deps);
    cleanupSessionIds.push("s1");

    let output = "";
    await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      {
        onData: (bytes) => {
          output += new TextDecoder().decode(bytes);
        },
        onExit: () => {},
        ...noFsCallbacks,
      },
    );

    manager.resize("s1", 120, 40);
    manager.data("s1", new TextEncoder().encode("stty size\n"));
    await waitFor(() => output.includes("40 120"));
    expect(output).toContain("40 120");
  });

  test("close() forcibly ends the session; has() returns false and further data() is a silent no-op", async () => {
    const { deps } = makeDeps();
    manager = createSessionManager(deps);

    await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );
    manager.close("s1");

    const m = manager;
    expect(m.has("s1")).toBe(false);
    expect(() => m.data("s1", new TextEncoder().encode("x"))).not.toThrow();
  });

  test("REQUIRED FAILURE PATH: a token with a tampered signature is rejected and no PTY is spawned", async () => {
    const { deps } = makeDeps();
    manager = createSessionManager(deps);

    const token = mintToken();
    const [claimsSegment, signatureSegment] = token.split(".") as [string, string];
    const sigBytes = Buffer.from(signatureSegment, "base64url");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    const tamperedToken = `${claimsSegment}.${sigBytes.toString("base64url")}`;

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: tamperedToken, cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
    expect(manager.has("s1")).toBe(false);
  });

  test("a token minted for a different machine is rejected as wrong_machine, even though the signature verifies", async () => {
    const { deps } = makeDeps();
    manager = createSessionManager(deps);

    const outcome = await manager.attach(
      {
        sessionId: "s1",
        sessionToken: mintToken({ targetMachineId: "some-other-machine" }),
        cols: 80,
        rows: 24,
      },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "wrong_machine" });
    expect(manager.has("s1")).toBe(false);
  });

  test("an expired token is rejected, no eager retry (a fresh key can't fix expiry)", async () => {
    const { deps, calls } = makeDeps();
    manager = createSessionManager(deps);

    const outcome = await manager.attach(
      {
        sessionId: "s1",
        sessionToken: mintToken({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
        cols: 80,
        rows: 24,
      },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "expired" });
    expect(calls.filter((c) => c === "invalidate")).toHaveLength(0);
  });

  test("invalid_signature triggers exactly one eager invalidate-and-retry, which succeeds once the fetcher returns the right key", async () => {
    let fetchCount = 0;
    const calls: string[] = [];
    const { deps } = makeDeps({
      // First fetch returns a stale/wrong key (as if the real signer rotated since the last
      // cache); the eager retry after `invalidateSessionTokenPublicKey()` gets the right one.
      getSessionTokenPublicKeyBytes: async () => {
        fetchCount += 1;
        calls.push("fetchKey");
        return fetchCount === 1 ? wrongPublicKeyDer : publicKeyDer;
      },
      invalidateSessionTokenPublicKey: () => {
        calls.push("invalidate");
      },
    });
    manager = createSessionManager(deps);
    cleanupSessionIds.push("s1");

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual(["fetchKey", "invalidate", "fetchKey"]);
  });

  test("invalid_signature retry that ALSO fails still rejects, without spawning a PTY", async () => {
    const { deps, calls } = makeDeps({
      getSessionTokenPublicKeyBytes: async () => wrongPublicKeyDer,
    });
    manager = createSessionManager(deps);

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
    expect(calls.filter((c) => c === "invalidate")).toHaveLength(1);
    expect(manager.has("s1")).toBe(false);
  });

  // REGRESSION: this is the crash that ended every session on a machine "from time to time".
  // The key fetch carries the daemon's own bearer, which lived 15 minutes and was only
  // refreshed on reconnect, so any attach on a longer-lived connection fetched with an
  // expired token and got a 401. The rejection escaped `attach` into `connection.ts`'s
  // un-awaited call, Bun killed the process, systemd restarted it five seconds later, and
  // the control plane closed every session on the machine because its daemon had dropped.
  test("a rejecting key fetch is a refused attach, not a rejection out of attach", async () => {
    const { deps } = makeDeps({
      getSessionTokenPublicKeyBytes: async () => {
        throw new ApiError(401, { reason: "expired" });
      },
    });
    manager = createSessionManager(deps);

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "verify_failed" });
    expect(manager.has("s1")).toBe(false);
  });

  test("an invalid_signature retry whose fetch rejects is also a refused attach", async () => {
    let fetchCount = 0;
    const { deps } = makeDeps({
      getSessionTokenPublicKeyBytes: async () => {
        fetchCount += 1;
        if (fetchCount === 1) return wrongPublicKeyDer;
        throw new Error("control plane unreachable");
      },
    });
    manager = createSessionManager(deps);

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "verify_failed" });
    expect(fetchCount).toBe(2);
  });

  // REQUIRED FAILURE PATH: a `spawnSession` throw (e.g. pty.ts's real `InvalidOsUserError`
  // for a malicious-shaped `targetOsUser`, or any other real spawn failure) must become a
  // graceful `{ok: false}` outcome, not an unhandled rejection — `attach` is called as
  // `void handleInboundFrame(...)` by its real caller (connection.ts), which does not await
  // or otherwise handle a thrown/rejected error from it.
  test("a spawnSession throw is caught and returned as a graceful ok:false outcome, not a rejection", async () => {
    const { deps } = makeDeps({
      spawnSession: () => {
        throw new Error("simulated spawn failure");
      },
    });
    manager = createSessionManager(deps);

    const outcome = await manager.attach(
      { sessionId: "s1", sessionToken: mintToken(), cols: 80, rows: 24 },
      { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
    );

    expect(outcome).toEqual({ ok: false, reason: "simulated spawn failure" });
    expect(manager.has("s1")).toBe(false);
  });
  // ---------------------------------------------------------------------------
  // Session KIND comes from the signed token, never from the frame.
  //
  // This is the property the two elevation levels rest on. A `file_recovery` grant can
  // mint a `method: "files"` token (control plane, `tunnel/access-authorization.ts`) but
  // never a `"terminal"` one. If the daemon took the kind from the `attach` frame instead,
  // anyone who could reach this socket with a files token would get a shell — and a shell
  // can read injected secrets, which is exactly what the lower level exists to withhold.
  // ---------------------------------------------------------------------------
  describe("session kind is decided by the token claim, not the attach frame", () => {
    test("a files-method token spawns the file helper and never a PTY", async () => {
      const spawned: string[] = [];
      const { deps } = makeDeps({
        spawnSession: () => {
          spawned.push("pty");
          throw new Error("a files token must never reach spawnSession");
        },
        spawnFilesSession: (options) => {
          spawned.push("files");
          return spawnFilesSession({ ...options, commandOverride: ["cat"] });
        },
      });
      manager = createSessionManager(deps);
      cleanupSessionIds.push("s1");

      const outcome = await manager.attach(
        { sessionId: "s1", sessionToken: mintToken({ method: "files" }), cols: 80, rows: 24 },
        { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
      );

      expect(outcome).toEqual({ ok: true });
      expect(spawned).toEqual(["files"]);
      expect(manager.has("s1")).toBe(true);
    });

    test("a terminal-method token spawns a PTY and never the file helper", async () => {
      const spawned: string[] = [];
      const { deps } = makeDeps({
        spawnSession: (options) => {
          spawned.push("pty");
          return realSpawnSession({ ...options, commandOverride: ["sh"] });
        },
        spawnFilesSession: () => {
          spawned.push("files");
          throw new Error("a terminal token must never reach spawnFilesSession");
        },
      });
      manager = createSessionManager(deps);
      cleanupSessionIds.push("s1");

      await manager.attach(
        { sessionId: "s1", sessionToken: mintToken({ method: "terminal" }), cols: 80, rows: 24 },
        { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
      );

      expect(spawned).toEqual(["pty"]);
    });

    // Version skew: a machine runs a compiled daemon that can trail the control plane by
    // weeks. This exact case shipped and was seen in production as
    // "This session has ended (malformed)" — a well-formed, correctly-signed token naming
    // `files`, rejected by an older daemon whose claims guard only knew terminal/ssh.
    // The token was fine; the daemon could not serve the method. Those are different facts.
    test("REQUIRED FAILURE PATH: a method this daemon does not implement is refused, not served as a PTY", async () => {
      const spawned: string[] = [];
      const { deps } = makeDeps({
        spawnSession: () => {
          spawned.push("pty");
          throw new Error("an unknown method must never reach spawnSession");
        },
        spawnFilesSession: () => {
          spawned.push("files");
          throw new Error("an unknown method must never reach spawnFilesSession");
        },
      });
      manager = createSessionManager(deps);

      const outcome = await manager.attach(
        {
          sessionId: "s1",
          sessionToken: mintToken({ method: "readonly" as never }),
          cols: 80,
          rows: 24,
        },
        { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
      );

      // Not "malformed": the token verified. The daemon simply has no such session kind.
      expect(outcome).toEqual({ ok: false, reason: "unsupported_method" });
      // And critically it did not fall through to a shell, which is what the old
      // `else` branch did for anything that was not exactly "files".
      expect(spawned).toEqual([]);
      expect(manager.has("s1")).toBe(false);
    });

    test("REQUIRED FAILURE PATH: fsRequest on a terminal session does nothing", async () => {
      const { deps } = makeDeps();
      manager = createSessionManager(deps);
      cleanupSessionIds.push("s1");

      await manager.attach(
        { sessionId: "s1", sessionToken: mintToken({ method: "terminal" }), cols: 80, rows: 24 },
        { onData: () => {}, onExit: () => {}, ...noFsCallbacks },
      );

      // A terminal session is in a different map, so a file operation aimed at it finds
      // nothing to run against. This is the second line of defence behind the token check
      // above: even a forged `fs_request` frame naming a live terminal session is inert.
      const live = manager;
      expect(() => live.fsRequest("s1", "r1", { op: "list", path: "/etc" })).not.toThrow();
      expect(() => live.fsChunk("s1", "r1", { seq: 0, dataBase64: "", final: true })).not.toThrow();
    });
  });
});

/**
 * The real deps factory, which is where the daemon's own credential handling lives. Stubs
 * `fetch` the same way `session-token-key.test.ts` does — `config.ts` is lazy, so setting
 * `CONTROL_PLANE_URL` per-test leaks into nothing.
 */
describe("createDefaultSessionManagerDeps: the bearer for the key fetch", () => {
  const originalFetch = globalThis.fetch;
  const originalControlPlaneUrl = process.env.CONTROL_PLANE_URL;

  beforeEach(() => {
    process.env.CONTROL_PLANE_URL = "http://localhost:0";
    clearCachedSessionTokenPublicKey();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.CONTROL_PLANE_URL = originalControlPlaneUrl;
    clearCachedSessionTokenPublicKey();
  });

  test("acquires a token per fetch, so a long-lived connection never fetches with a stale one", async () => {
    const bearers: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bearers.push(String((init?.headers as Record<string, string>).authorization));
      return new Response(JSON.stringify({ keyId: "session-token", publicKeyDerBase64: "AAAA" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    let minted = 0;
    const deps = createDefaultSessionManagerDeps({
      machineId: "machine-1",
      getBearerToken: async () => `bearer-${++minted}`,
      invalidateBearerToken: () => {},
    });

    await deps.getSessionTokenPublicKeyBytes();
    clearCachedSessionTokenPublicKey();
    await deps.getSessionTokenPublicKeyBytes();

    // Two fetches, two separately-acquired tokens — not one captured at startup and reused
    // for the life of the process.
    expect(bearers).toEqual(["Bearer bearer-1", "Bearer bearer-2"]);
  });

  test("a 401 drops the cached attestation and retries once with a fresh token", async () => {
    const bearers: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string>).authorization);
      bearers.push(authorization);
      if (authorization === "Bearer stale") {
        return new Response(JSON.stringify({ reason: "expired" }), { status: 401 });
      }
      return new Response(JSON.stringify({ keyId: "session-token", publicKeyDerBase64: "AAAA" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const queue = ["stale", "fresh"];
    let invalidated = 0;
    const deps = createDefaultSessionManagerDeps({
      machineId: "machine-1",
      getBearerToken: async () => queue.shift() ?? "fresh",
      invalidateBearerToken: () => {
        invalidated += 1;
      },
    });

    const bytes = await deps.getSessionTokenPublicKeyBytes();

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(invalidated).toBe(1);
    expect(bearers).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("a non-401 failure propagates rather than burning a re-attest on it", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;

    let invalidated = 0;
    const deps = createDefaultSessionManagerDeps({
      machineId: "machine-1",
      getBearerToken: async () => "bearer-1",
      invalidateBearerToken: () => {
        invalidated += 1;
      },
    });

    await expect(deps.getSessionTokenPublicKeyBytes()).rejects.toMatchObject({ status: 503 });
    expect(invalidated).toBe(0);
  });
});
