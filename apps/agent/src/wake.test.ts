import { afterEach, describe, expect, test } from "bun:test";
import { connectWake, isWakeMessage } from "./wake";

describe("isWakeMessage", () => {
  test("accepts exactly {type: 'pull_now'}", () => {
    expect(isWakeMessage({ type: "pull_now" })).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isWakeMessage({ type: "something_else" })).toBe(false);
    expect(isWakeMessage(null)).toBe(false);
    expect(isWakeMessage("pull_now")).toBe(false);
    expect(isWakeMessage(undefined)).toBe(false);
  });

  test("only the `type` field is load-bearing — an extra key doesn't disqualify it", () => {
    expect(isWakeMessage({ type: "pull_now", extra: "ignored" })).toBe(true);
  });
});

describe("connectWake", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  const startMockWakeServer = (
    onWebsocket: (ws: import("bun").ServerWebSocket<unknown>) => void,
    onRequest?: (req: Request) => void,
  ) =>
    Bun.serve({
      port: 0,
      fetch(req, srv) {
        onRequest?.(req);
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not a websocket request", { status: 400 });
      },
      websocket: {
        open(ws) {
          onWebsocket(ws);
        },
        message() {
          /* the agent never sends anything over this channel */
        },
        close() {},
      },
    });

  test("calls onPullNow exactly once per pull_now frame the server sends", async () => {
    let serverSocket: import("bun").ServerWebSocket<unknown> | undefined;
    server = startMockWakeServer((ws) => {
      serverSocket = ws;
    });

    let pulls = 0;
    const connection = connectWake(
      `ws://localhost:${server.port}/api/v1/agent/wake`,
      () => Promise.resolve("fake-bearer-token"),
      () => {
        pulls += 1;
      },
    );

    try {
      for (let i = 0; i < 200 && !serverSocket; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(serverSocket).toBeDefined();

      serverSocket?.send(JSON.stringify({ type: "pull_now" }));
      for (let i = 0; i < 200 && pulls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pulls).toBe(1);

      // A second frame triggers a second, independent call — this is a signal, not a toggle.
      serverSocket?.send(JSON.stringify({ type: "pull_now" }));
      for (let i = 0; i < 200 && pulls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pulls).toBe(2);
    } finally {
      connection.close();
    }
  });

  test("ignores a frame that isn't the wake message", async () => {
    let serverSocket: import("bun").ServerWebSocket<unknown> | undefined;
    server = startMockWakeServer((ws) => {
      serverSocket = ws;
    });

    let pulls = 0;
    const connection = connectWake(
      `ws://localhost:${server.port}/api/v1/agent/wake`,
      () => Promise.resolve("fake-bearer-token"),
      () => {
        pulls += 1;
      },
    );

    try {
      for (let i = 0; i < 200 && !serverSocket; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      serverSocket?.send("not json at all");
      serverSocket?.send(JSON.stringify({ type: "something_else" }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(pulls).toBe(0);
    } finally {
      connection.close();
    }
  });

  test("sends the bearer token as an authorization header on connect", async () => {
    // A plain object property, not a bare `let` — a `let` reassigned only inside a nested
    // closure (`onRequest` below) gets narrowed by TS to its initializer's literal type at
    // every read in this outer scope, since it can't see the closure ever running.
    const received: { auth: string | null } = { auth: null };
    server = startMockWakeServer(
      () => {},
      (req) => {
        received.auth = req.headers.get("authorization");
      },
    );

    const connection = connectWake(
      `ws://localhost:${server.port}/api/v1/agent/wake`,
      () => Promise.resolve("my-token-123"),
      () => {},
    );

    try {
      for (let i = 0; i < 200 && !received.auth; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received.auth).toBe("Bearer my-token-123");
    } finally {
      connection.close();
    }
  });

  test("reconnects with a freshly fetched bearer token after the server drops the connection", async () => {
    let opens = 0;
    server = startMockWakeServer((ws) => {
      opens += 1;
      if (opens === 1) ws.close(); // force exactly one reconnect
    });

    let tokenFetches = 0;
    const connection = connectWake(
      `ws://localhost:${server.port}/api/v1/agent/wake`,
      () => {
        tokenFetches += 1;
        return Promise.resolve(`token-${tokenFetches}`);
      },
      () => {},
    );

    try {
      for (let i = 0; i < 300 && opens < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(opens).toBeGreaterThanOrEqual(2);
      // One fetch for the initial connect, at least one more for the reconnect — never cached
      // across a reconnect the way the poll/report loop's own bearer token is.
      expect(tokenFetches).toBeGreaterThanOrEqual(2);
    } finally {
      connection.close();
    }
  });

  test("close() stops reconnecting after the server drops the connection", async () => {
    let openCount = 0;
    server = startMockWakeServer((ws) => {
      openCount += 1;
      ws.close();
    });

    const connection = connectWake(
      `ws://localhost:${server.port}/api/v1/agent/wake`,
      () => Promise.resolve("fake-bearer-token"),
      () => {},
    );

    for (let i = 0; i < 200 && openCount < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(openCount).toBeGreaterThanOrEqual(1);

    const countAtClose = openCount;
    connection.close(); // synchronous: cancels the pending reconnect timer, no await in between
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(openCount).toBe(countAtClose);
  });
});
