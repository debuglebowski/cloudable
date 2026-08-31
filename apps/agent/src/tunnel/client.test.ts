import { afterEach, describe, expect, test } from "bun:test";
import type {
  PtyHandle,
  PtySpawnCallbacks,
  SessionClaims,
  SpawnPty,
  TunnelWireMessage,
} from "./client";
import { runTunnelSession, spawnRealPty } from "./client";

// ---------------------------------------------------------------------------
// All tests run against a real Bun.serve websocket server in-process — no
// real control plane needed, per this unit's brief. `packages/contracts` has
// no wire-type entry for this yet (see client.ts's file banner), so tests
// build/parse `TunnelWireMessage` frames directly.
// ---------------------------------------------------------------------------

const toBase64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const fromBase64 = (text: string): string => Buffer.from(text, "base64").toString("utf8");

const CLAIMS_SEGMENT = (overrides: Partial<Record<string, unknown>> = {}): string => {
  const claims = {
    idpIdentity: "person@example.test",
    targetMachineId: "machine-1",
    targetOsUser: "ubuntu",
    method: "terminal",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  return Buffer.from(JSON.stringify(claims)).toString("base64url");
};

/** A well-formed-looking token per this build's `<claims>.<signature>` shape — paired with
 * `fakeVerify` below (not the real signature check, which has its own dedicated test file,
 * `session-token-verify.test.ts`), so `.not-a-real-signature` is never actually checked here. */
const validToken = (overrides: Partial<Record<string, unknown>> = {}): string =>
  `${CLAIMS_SEGMENT(overrides)}.not-a-real-signature`;

/** Test double for `verifySessionToken`, injected into every `runTunnelSession` call below.
 * Exercises the SAME shape/expiry control-flow real client.ts code depends on (malformed
 * shape rejected, expired claims rejected, otherwise resolved) without needing a real signer
 * key pair or a running control plane — deliberately does not check the signature segment,
 * since that's `session-token-verify.test.ts`'s job, not this file's. */
async function fakeVerify(token: string): Promise<SessionClaims> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("malformed");
  const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const expiresAt = new Date(claims.expiresAt as string);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new Error("expired");
  }
  return {
    idpIdentity: claims.idpIdentity as string,
    targetMachineId: claims.targetMachineId as string,
    targetOsUser: claims.targetOsUser as string,
    method: claims.method as SessionClaims["method"],
    issuedAt: new Date(claims.issuedAt as string),
    expiresAt,
  };
}

interface FakePty {
  spawnPty: SpawnPty;
  readonly written: Uint8Array[];
  readonly resized: Array<[number, number]>;
  killCount: number;
  callbacks?: PtySpawnCallbacks;
}

/** A fast, deterministic fake PTY: echoes back whatever is written to it, and sends a fixed
 * "ready" handshake immediately on spawn so tests can synchronize on "the PTY now exists"
 * without a real process or an arbitrary sleep. */
function makeFakePty(): FakePty {
  // A single mutable object, closed over by `spawnPty` AND returned to the test — not a copy —
  // so mutations made inside the closure (`fake.callbacks = ...`, `fake.killCount += 1`) are
  // visible to the test's own reference to `fake`.
  const fake: FakePty = {
    written: [],
    resized: [],
    killCount: 0,
    spawnPty: () => ({}) as PtyHandle,
  };
  fake.spawnPty = (_cols, _rows, callbacks) => {
    fake.callbacks = callbacks;
    callbacks.onData(new TextEncoder().encode("ready"));
    const handle: PtyHandle = {
      write: (data) => {
        fake.written.push(data);
        callbacks.onData(data);
      },
      resize: (cols, rows) => {
        fake.resized.push([cols, rows]);
      },
      kill: () => {
        fake.killCount += 1;
      },
    };
    return handle;
  };
  return fake;
}

interface MockServer {
  readonly url: string;
  readonly received: TunnelWireMessage[];
  readonly connectionCount: () => number;
  send(message: TunnelWireMessage): void;
  closeAllSockets(): void;
  stop(): void;
}

/** Starts a real Bun.serve websocket server on a random free port. `onOpen` lets a test decide
 * per-connection behavior (e.g. counting reconnect attempts, or closing immediately). */
function startMockServer(options: { onOpen?: () => void } = {}): MockServer {
  const received: TunnelWireMessage[] = [];
  const sockets = new Set<import("bun").ServerWebSocket<undefined>>();
  let connectionCount = 0;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        connectionCount += 1;
        sockets.add(ws);
        options.onOpen?.();
      },
      message(_ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        try {
          received.push(JSON.parse(text) as TunnelWireMessage);
        } catch {
          // ignore malformed test noise
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    url: `ws://localhost:${server.port}`,
    received,
    connectionCount: () => connectionCount,
    send: (message) => {
      for (const ws of sockets) ws.send(JSON.stringify(message));
    },
    closeAllSockets: () => {
      for (const ws of sockets) ws.close();
    },
    stop: () => server.stop(true),
  };
}

/** Polls `predicate` until it's true or `timeoutMs` elapses. Every test below waits on some
 * observable side effect rather than a fixed sleep, to stay fast and non-flaky. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Re-sends `message` every 100ms until `predicate` observes its effect (or `timeoutMs`
 * elapses) — used for the real-shell tests instead of a fixed "give the shell a moment to
 * start" sleep, since re-sending the same command is harmless (it either lands before the
 * shell is ready and is simply not yet read, or lands again after — both fine here). */
async function sendUntilObserved(
  server: MockServer,
  message: TunnelWireMessage,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("sendUntilObserved: timed out");
    server.send(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const activeServers: MockServer[] = [];
function registerServer(server: MockServer): MockServer {
  activeServers.push(server);
  return server;
}

afterEach(() => {
  while (activeServers.length > 0) activeServers.pop()?.stop();
});

describe("runTunnelSession — verification gate", () => {
  test("a malformed token never spawns a PTY and ends the session without retrying", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();

    await runTunnelSession({
      url: server.url,
      sessionToken: "not-even-two-segments",
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
    });

    expect(pty.callbacks).toBeUndefined();
    expect(pty.written).toHaveLength(0);
  });

  test("an expired token never spawns a PTY", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();

    await runTunnelSession({
      url: server.url,
      sessionToken: validToken({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
    });

    expect(pty.callbacks).toBeUndefined();
  });

  test("a well-formed, unexpired token spawns a PTY", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();
    const controller = new AbortController();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
      signal: controller.signal,
    });

    await waitFor(() => pty.callbacks !== undefined);
    controller.abort();
    await done;
  });
});

describe("runTunnelSession — byte relay", () => {
  test("data frames relay bidirectionally", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();
    const controller = new AbortController();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
      signal: controller.signal,
    });

    // Synchronize on the fake PTY's handshake byte, relayed back over the socket.
    await waitFor(() =>
      server.received.some((m) => m.type === "data" && fromBase64(m.dataBase64) === "ready"),
    );

    server.send({ type: "data", dataBase64: toBase64("echo me") });

    await waitFor(() =>
      server.received.some((m) => m.type === "data" && fromBase64(m.dataBase64) === "echo me"),
    );
    expect(pty.written.map((b) => new TextDecoder().decode(b))).toContain("echo me");

    controller.abort();
    await done;
  });

  test("resize messages reach the PTY", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();
    const controller = new AbortController();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
      signal: controller.signal,
    });

    await waitFor(() => pty.callbacks !== undefined);
    server.send({ type: "resize", cols: 120, rows: 40 });
    await waitFor(() => pty.resized.length > 0);

    expect(pty.resized).toEqual([[120, 40]]);

    controller.abort();
    await done;
  });
});

describe("runTunnelSession — terminate and exit", () => {
  test("a terminate message kills the process and ends the session", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
    });

    await waitFor(() => pty.callbacks !== undefined);
    server.send({ type: "terminate" });

    await done; // resolves once the session ends for good — no signal/abort needed here.
    expect(pty.killCount).toBe(1);
  });

  test("the process exiting on its own reports `exited` and ends the session", async () => {
    const server = registerServer(startMockServer());
    const pty = makeFakePty();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
    });

    await waitFor(() => pty.callbacks !== undefined);
    pty.callbacks?.onExit(0);

    await done;
    expect(server.received.some((m) => m.type === "exited" && m.exitCode === 0)).toBe(true);
  });
});

describe("runTunnelSession — reconnect with backoff", () => {
  test("an unexpected disconnect reconnects rather than giving up", async () => {
    let opens = 0;
    const server = registerServer(
      startMockServer({
        onOpen: () => {
          opens += 1;
          // Every connection but the last (of the 3 we expect) is dropped immediately,
          // simulating a transient network failure the client must recover from on its own.
        },
      }),
    );
    const pty = makeFakePty();
    const controller = new AbortController();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: pty.spawnPty,
      verifySessionToken: fakeVerify,
      signal: controller.signal,
      backoff: { baseMs: 5, capMs: 20 },
    });

    await waitFor(() => opens >= 1);
    server.closeAllSockets();
    await waitFor(() => opens >= 2, 5_000);
    server.closeAllSockets();
    await waitFor(() => opens >= 3, 5_000);

    controller.abort();
    await done;
    expect(opens).toBeGreaterThanOrEqual(3);
  });
});

describe("spawnRealPty — genuine PTY relay (no e2e against a real control plane)", () => {
  test("a real shell echoes input back through the tunnel", async () => {
    const server = registerServer(startMockServer());
    const controller = new AbortController();

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: spawnRealPty,
      verifySessionToken: fakeVerify,
      signal: controller.signal,
    });

    const marker = "CLOUDABLE_TUNNEL_TEST_MARKER";
    const outputContains = () =>
      server.received
        .filter((m) => m.type === "data")
        .map((m) => (m.type === "data" ? fromBase64(m.dataBase64) : ""))
        .join("")
        .includes(marker);
    // Re-sends the command until the shell has actually started reading and echoes it back —
    // no fixed "give it a moment" sleep.
    await sendUntilObserved(
      server,
      { type: "data", dataBase64: toBase64(`echo ${marker}\n`) },
      outputContains,
    );

    server.send({ type: "terminate" });
    await done;
    controller.abort();
  }, 15_000);

  test("reports the real process exit code, not the PTY stream's own lifecycle status", async () => {
    // Regression test: `Bun.Terminal`'s own `exit` callback reports a PTY *stream* lifecycle
    // status (0 = clean EOF, 1 = read error) — NOT the child process's exit code. `spawnRealPty`
    // must get the real exit code from `Subprocess.exited` instead. A shell exiting `42` would
    // read back as the PTY's own (typically `0`, clean EOF) status if that bug were still here.
    const server = registerServer(startMockServer());

    const done = runTunnelSession({
      url: server.url,
      sessionToken: validToken(),
      spawnPty: spawnRealPty,
      verifySessionToken: fakeVerify,
    });

    // Re-sends until the shell has actually started reading and exits — no fixed sleep.
    await sendUntilObserved(server, { type: "data", dataBase64: toBase64("exit 42\n") }, () =>
      server.received.some((m) => m.type === "exited"),
    );
    await done;

    const exited = server.received.find((m) => m.type === "exited");
    expect(exited?.type).toBe("exited");
    expect(exited && exited.type === "exited" ? exited.exitCode : undefined).toBe(42);
  }, 15_000);
});
