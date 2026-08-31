import { afterEach, beforeAll, describe, expect, test } from "bun:test";

// See wake.test.ts's comment on the same pattern: `config.ts` reads `CONTROL_PLANE_URL` (and
// `MACHINE_TOKEN`) once, at the first import of anything that pulls it in — so there's
// exactly one dynamic import here, in `beforeAll`, after fixing the env vars and reserving a
// port every test below reuses for its own mock control plane.
let loop: typeof import("./poll-report-loop");
let attestation: typeof import("./attestation");
let port: number;

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  if (probe.port === undefined) throw new Error("Bun.serve did not assign a TCP port");
  port = probe.port;
  probe.stop(true);
  process.env.CONTROL_PLANE_URL = `http://localhost:${port}`;
  process.env.MACHINE_TOKEN = "fake-machine-token";
  loop = await import("./poll-report-loop");
  attestation = await import("./attestation");
});

/** A minimal, real mock of all four agent-protocol operations (attest/poll/report/wake). */
function startMockControlPlane(onPoll: () => void) {
  let wakeSocket: import("bun").ServerWebSocket<unknown> | undefined;

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/agent/wake") {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("expected a websocket upgrade", { status: 400 });
      }
      if (url.pathname === "/api/v1/agent/attest" && req.method === "POST") {
        return Response.json({
          bearerToken: "fake-bearer-token",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          orgId: "org-1",
          machineId: "machine-1",
        });
      }
      if (url.pathname === "/api/v1/agent/poll" && req.method === "GET") {
        onPoll();
        return Response.json(
          { version: "v1", packages: [], settings: {} },
          { headers: { etag: '"v1"' } },
        );
      }
      if (url.pathname === "/api/v1/agent/report" && req.method === "POST") {
        return Response.json({ acknowledged: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        wakeSocket = ws;
      },
      message() {},
      close() {
        wakeSocket = undefined;
      },
    },
  });

  return {
    server,
    sendWake(): void {
      wakeSocket?.send(JSON.stringify({ type: "pull_now" }));
    },
    hasWakeSocket(): boolean {
      return wakeSocket !== undefined;
    },
  };
}

describe("runAgentLoop", () => {
  let mock: ReturnType<typeof startMockControlPlane> | undefined;

  afterEach(() => {
    mock?.server.stop(true);
    mock = undefined;
    // `attest()` caches its session at module scope for the life of the process (see
    // attestation.ts) — cleared between tests so each one actually re-attests against its own
    // mock server's `/attest` handler instead of silently reusing a still-fresh session minted
    // by the previous test's server.
    attestation.clearCachedSession();
  });

  test("a wake message short-circuits the sleep between cycles instead of waiting out the full interval", async () => {
    const pollTimestamps: number[] = [];
    mock = startMockControlPlane(() => pollTimestamps.push(Date.now()));

    const controller = new AbortController();
    const loopPromise = loop.runAgentLoop({ signal: controller.signal });

    try {
      // The loop's very first cycle.
      for (let i = 0; i < 300 && pollTimestamps.length < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pollTimestamps.length).toBeGreaterThanOrEqual(1);

      // Let the wake connection finish opening before waking it.
      for (let i = 0; i < 300 && !mock.hasWakeSocket(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(mock.hasWakeSocket()).toBe(true);

      const beforeWake = Date.now();
      mock.sendWake();

      // The loop's normal poll interval is 30 seconds (`POLL_INTERVAL_MS`) — a second poll
      // landing within a couple of seconds of the wake is exactly "didn't wait out the
      // interval," not merely "eventually polled again."
      for (let i = 0; i < 400 && pollTimestamps.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pollTimestamps.length).toBeGreaterThanOrEqual(2);

      const secondPollAt = pollTimestamps.at(1);
      if (secondPollAt === undefined) throw new Error("expected a second poll timestamp");
      expect(secondPollAt - beforeWake).toBeLessThan(5_000);
    } finally {
      controller.abort();
      await expect(loopPromise).rejects.toThrow("agent loop aborted");
    }
  }, 15_000);

  test("without a wake, the loop still polls again on its own — the fast path only changes latency", async () => {
    const pollTimestamps: number[] = [];
    mock = startMockControlPlane(() => pollTimestamps.push(Date.now()));

    const controller = new AbortController();
    const loopPromise = loop.runAgentLoop({ signal: controller.signal });

    try {
      for (let i = 0; i < 300 && pollTimestamps.length < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pollTimestamps.length).toBeGreaterThanOrEqual(1);
    } finally {
      controller.abort();
      await expect(loopPromise).rejects.toThrow("agent loop aborted");
    }
  }, 15_000);

  test("abort lands mid-cycle (not during a sleep) still exits promptly, not after a full wait", async () => {
    let reportInFlight = false;
    const server = Bun.serve({
      port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/agent/wake") {
          if (srv.upgrade(req, { data: undefined })) return;
          return new Response("expected a websocket upgrade", { status: 400 });
        }
        if (url.pathname === "/api/v1/agent/attest" && req.method === "POST") {
          return Response.json({
            bearerToken: "fake-bearer-token",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            orgId: "org-1",
            machineId: "machine-1",
          });
        }
        if (url.pathname === "/api/v1/agent/poll" && req.method === "GET") {
          return Response.json(
            { version: "v1", packages: [], settings: {} },
            { headers: { etag: '"v1"' } },
          );
        }
        if (url.pathname === "/api/v1/agent/report" && req.method === "POST") {
          reportInFlight = true;
          // Holds this cycle open well past when the test below calls `abort()`, so the
          // abort unambiguously lands mid-cycle rather than during `waker.wait()`.
          await new Promise((resolve) => setTimeout(resolve, 500));
          return Response.json({ acknowledged: true });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: { open() {}, message() {}, close() {} },
    });

    const controller = new AbortController();
    const loopPromise = loop.runAgentLoop({ signal: controller.signal });

    try {
      for (let i = 0; i < 300 && !reportInFlight; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(reportInFlight).toBe(true);

      controller.abort();
      const start = Date.now();
      await expect(loopPromise).rejects.toThrow("agent loop aborted");
      const elapsed = Date.now() - start;
      // Bounded well under `POLL_INTERVAL_MS` (30s) and light-years under the ~10min backoff
      // cap — proves the loop exited right after the in-flight report finished rather than
      // going on to wait out a full interval with nothing left to short-circuit it.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
