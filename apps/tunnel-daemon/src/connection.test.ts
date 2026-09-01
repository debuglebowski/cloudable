import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TunnelFrame } from "@cloudable/contracts";
import { runConnectionLoop } from "./connection";
import type { AttachOutcome, SessionManager } from "./session-manager";

class FakeWebSocket {
  sent: string[] = [];
  onmessage: ((event: { data: string | Uint8Array }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(
    public url: string,
    public options: { headers: Record<string, string> },
  ) {}

  closeCalls = 0;

  send(data: string) {
    if (this.closed) throw new Error("send on a closed socket");
    this.sent.push(data);
  }

  /** Real `WebSocket.close()` — what `connection.ts`'s abort-signal wiring calls. Mirrors a
   * real socket's behavior: closing eventually fires `onclose`, it doesn't settle synchronously. */
  close() {
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /** Test helper: simulate the control plane sending this daemon a frame. */
  receive(frame: TunnelFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  receiveRaw(data: string) {
    this.onmessage?.({ data });
  }

  triggerClose() {
    this.closed = true;
    this.onclose?.();
  }

  triggerError() {
    this.closed = true;
    this.onerror?.();
  }

  sentFrames(): TunnelFrame[] {
    return this.sent.map((s) => JSON.parse(s) as TunnelFrame);
  }
}

function fakeSessionManager(overrides: Partial<SessionManager> = {}): {
  manager: SessionManager;
  calls: string[];
} {
  const calls: string[] = [];
  const manager: SessionManager = {
    attach: async (input) => {
      calls.push(`attach:${input.sessionId}`);
      return { ok: true } satisfies AttachOutcome;
    },
    data: (sessionId) => {
      calls.push(`data:${sessionId}`);
    },
    resize: (sessionId, cols, rows) => {
      calls.push(`resize:${sessionId}:${cols}x${rows}`);
    },
    close: (sessionId) => {
      calls.push(`close:${sessionId}`);
    },
    has: () => true,
    ...overrides,
  };
  return { manager, calls };
}

describe("connection: inbound frame handling (via a fake WebSocket)", () => {
  let sockets: FakeWebSocket[];
  let abortController: AbortController;

  beforeEach(() => {
    sockets = [];
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  /** Starts the loop, waits for the first fake socket to exist, and returns it. The loop is
   * aborted (via `abortController`) at the end of every test — its `for(;;)` only checks
   * `signal.aborted` between connection attempts, so a still-open fake socket doesn't keep
   * the loop itself alive beyond the test. */
  async function startLoopAndGetSocket(manager: SessionManager): Promise<FakeWebSocket> {
    void runConnectionLoop(
      {
        wsUrl: "ws://fake/api/v1/tunnel/connect",
        sessionManager: manager,
        attest: async () => ({ bearerToken: "fake-bearer" }),
        createWebSocket: (url, options) => {
          const socket = new FakeWebSocket(url, options);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        sleep: async () => {},
      },
      { signal: abortController.signal },
    ).catch(() => {});

    // The socket is constructed synchronously inside the first loop iteration's
    // `runOneConnection` call, itself awaited after a synchronous `attestFn()` resolution —
    // a microtask tick is enough for it to exist.
    await Promise.resolve();
    await Promise.resolve();
    const socket = sockets[0];
    if (!socket) throw new Error("expected a fake socket to have been created");
    return socket;
  }

  test("passes the bearer token from attest() as the Authorization header", async () => {
    const { manager } = fakeSessionManager();
    const socket = await startLoopAndGetSocket(manager);
    expect(socket.options.headers.authorization).toBe("Bearer fake-bearer");
  });

  test("an `attach` frame calls sessionManager.attach and sends back `attached` on success", async () => {
    const { manager, calls } = fakeSessionManager();
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({ kind: "attach", sessionId: "s1", sessionToken: "tok", cols: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContain("attach:s1");
    expect(socket.sentFrames()).toContainEqual({ kind: "attached", sessionId: "s1" });
  });

  test("an `attach` frame sends back `attach_rejected` with the real reason on failure", async () => {
    const { manager } = fakeSessionManager({
      attach: async () => ({ ok: false, reason: "invalid_signature" }) satisfies AttachOutcome,
    });
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({ kind: "attach", sessionId: "s1", sessionToken: "tok", cols: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.sentFrames()).toContainEqual({
      kind: "attach_rejected",
      sessionId: "s1",
      reason: "invalid_signature",
    });
  });

  test("session-manager's onData callback is forwarded as a real `data` frame", async () => {
    let capturedOnData: ((bytes: Uint8Array) => void) | undefined;
    const { manager } = fakeSessionManager({
      attach: async (_input, callbacks) => {
        capturedOnData = callbacks.onData;
        return { ok: true };
      },
    });
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({ kind: "attach", sessionId: "s1", sessionToken: "tok", cols: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();

    capturedOnData?.(new TextEncoder().encode("hello"));
    const dataFrame = socket.sentFrames().find((f) => f.kind === "data");
    expect(dataFrame).toEqual({
      kind: "data",
      sessionId: "s1",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
  });

  test("session-manager's onExit callback is forwarded as a `close` frame with reason process_exited", async () => {
    let capturedOnExit: (() => void) | undefined;
    const { manager } = fakeSessionManager({
      attach: async (_input, callbacks) => {
        capturedOnExit = () => callbacks.onExit({ exitCode: 0, signalCode: null });
        return { ok: true };
      },
    });
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({ kind: "attach", sessionId: "s1", sessionToken: "tok", cols: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();

    capturedOnExit?.();
    expect(socket.sentFrames()).toContainEqual({
      kind: "close",
      sessionId: "s1",
      reason: "process_exited",
    });
  });

  test("a `data` frame dispatches decoded bytes to sessionManager.data", async () => {
    const received: Array<{ sessionId: string; bytes: string }> = [];
    const { manager } = fakeSessionManager({
      data: (sessionId, bytes) => {
        received.push({ sessionId, bytes: new TextDecoder().decode(bytes) });
      },
    });
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({
      kind: "data",
      sessionId: "s1",
      dataBase64: Buffer.from("typed input").toString("base64"),
    });
    await Promise.resolve();

    expect(received).toEqual([{ sessionId: "s1", bytes: "typed input" }]);
  });

  test("a `resize` frame dispatches to sessionManager.resize", async () => {
    const { manager, calls } = fakeSessionManager();
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({ kind: "resize", sessionId: "s1", cols: 120, rows: 40 });
    await Promise.resolve();

    expect(calls).toContain("resize:s1:120x40");
  });

  test("a `close` frame dispatches to sessionManager.close", async () => {
    const { manager, calls } = fakeSessionManager();
    const socket = await startLoopAndGetSocket(manager);

    socket.receive({ kind: "close", sessionId: "s1", reason: "person_ended" });
    await Promise.resolve();

    expect(calls).toContain("close:s1");
  });

  test("a malformed, non-JSON inbound message is silently ignored, not a crash", async () => {
    const { manager, calls } = fakeSessionManager();
    const socket = await startLoopAndGetSocket(manager);

    expect(() => socket.receiveRaw("not-json-garbage")).not.toThrow();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("reconnects after a close, with a fresh socket, and resets attempt after a stable connection", async () => {
    const { manager } = fakeSessionManager();
    const first = await startLoopAndGetSocket(manager);

    first.triggerClose();
    // Let the loop's catch/backoff/sleep/retry cycle run — `sleep` is faked to resolve
    // immediately, so this doesn't actually wait through a real backoff delay.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets[1]).not.toBe(first);
  });

  // REQUIRED FAILURE PATH — found the hard way running this live: without wiring the abort
  // signal into a real `ws.close()`, a live connection has no other natural end, so
  // `runConnectionLoop`'s own doc comment ("`signal` is the only way out") was a lie for as
  // long as the connection stayed open. This is the regression test for that fix.
  test("aborting while a connection is live actually closes the socket and stops the loop", async () => {
    const { manager } = fakeSessionManager();
    const localAbort = new AbortController();
    let settled: "resolved" | "rejected" | undefined;

    const loopPromise = runConnectionLoop(
      {
        wsUrl: "ws://fake/api/v1/tunnel/connect",
        sessionManager: manager,
        attest: async () => ({ bearerToken: "fake-bearer" }),
        createWebSocket: (url, options) => {
          const socket = new FakeWebSocket(url, options);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        sleep: async () => {},
      },
      { signal: localAbort.signal },
    ).then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    const socket = sockets[0];
    if (!socket) throw new Error("expected a fake socket");
    expect(socket.closed).toBe(false);

    localAbort.abort();
    await loopPromise;

    expect(socket.closeCalls).toBe(1);
    expect(socket.closed).toBe(true);
    expect(settled).toBe("rejected");
  });
});

describe("connection: the outer loop tolerates a failing attest()", () => {
  test("an attest() rejection is caught and the loop still backs off and retries rather than crashing", async () => {
    const abortController = new AbortController();
    let attestCalls = 0;
    let sleepCalls = 0;

    const { manager } = fakeSessionManager();
    const loopPromise = runConnectionLoop(
      {
        wsUrl: "ws://fake/api/v1/tunnel/connect",
        sessionManager: manager,
        attest: async () => {
          attestCalls += 1;
          throw new Error("attest failed");
        },
        createWebSocket: () => {
          throw new Error("should never construct a socket if attest() fails first");
        },
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls >= 3) abortController.abort();
        },
      },
      { signal: abortController.signal },
    );

    await expect(loopPromise).rejects.toThrow("connection loop aborted");
    expect(attestCalls).toBeGreaterThanOrEqual(3);
    expect(sleepCalls).toBeGreaterThanOrEqual(3);
  });
});
