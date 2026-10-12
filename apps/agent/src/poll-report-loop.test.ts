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

      // `makeWaker`'s own doc comment (poll-report-loop.ts): a `pullNow()` that lands between
      // cycles — nothing pending yet, e.g. the loop is still mid-report — is a documented no-op;
      // only a wake landing *during* an in-progress `wait()` cuts it short. A single `sendWake()`
      // can race that narrow window, so this resends every 100ms rather than asserting a single
      // shot always lands — that's testing the fast path exists and works, not asserting away an
      // acknowledged, acceptable race in the implementation.
      //
      // The loop's normal poll interval is 30 seconds (`POLL_INTERVAL_MS`) — a second poll
      // landing within a couple of seconds of the wake is exactly "didn't wait out the
      // interval," not merely "eventually polled again."
      for (let i = 0; i < 40 && pollTimestamps.length < 2; i++) {
        mock.sendWake();
        await new Promise((resolve) => setTimeout(resolve, 100));
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

/** A stand-in for the vulnerability scan manager that records what the loop does with it. */
function fakeScanManager(init: {
  scanner?: { name: "trivy"; version: string };
  pending?: import("@cloudable/contracts").VulnerabilityScanReport;
}) {
  let pending = init.pending;
  const calls = { setSettings: [] as unknown[], ticks: 0, acknowledged: [] as string[] };
  const manager: import("./vulnerability-scan/scan-manager").ScanManager = {
    setSettings: (settings) => {
      calls.setSettings.push(settings);
    },
    tick: () => {
      calls.ticks += 1;
    },
    installedScanner: () => init.scanner,
    pendingReport: () => pending,
    acknowledge: (scanId) => {
      calls.acknowledged.push(scanId);
      if (pending?.scanId === scanId) pending = undefined;
    },
    idle: () => Promise.resolve(),
  };
  return { manager, calls };
}

const SCAN_SETTINGS = {
  vulnerabilityScan: {
    scanner: "trivy",
    scope: "os",
    scanDays: ["sun"],
    scanTimeUtc: "02:00",
    dbRepository: null,
    release: null,
  },
};

const FINISHED_SCAN: import("@cloudable/contracts").VulnerabilityScanReport = {
  scanId: "scan-1",
  scanner: "trivy",
  scannerVersion: "0.75.0",
  scope: "os",
  startedAt: "2026-10-11T02:05:00.000Z",
  finishedAt: "2026-10-11T02:06:00.000Z",
  outcome: "completed",
  truncated: false,
  findings: [
    {
      vulnerabilityId: "CVE-2026-0001",
      ecosystem: "os",
      packageName: "openssl",
      installedVersion: "3.0.2-0ubuntu1",
      fixedVersion: "3.0.2-0ubuntu1.18",
      severity: "high",
    },
  ],
};

/**
 * A mock control plane for the scanning tests: scripted polls and reports, the report bodies
 * recorded, and a wake socket so a test can start the next cycle without waiting 30 seconds.
 */
function startScanMock(script: {
  poll: (call: number, ifNoneMatch: string | null) => Response;
  report: (call: number) => Response;
}) {
  const reports: Record<string, unknown>[] = [];
  const polls: { ifNoneMatch: string | null }[] = [];
  let wakeSocket: import("bun").ServerWebSocket<unknown> | undefined;
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
        const ifNoneMatch = req.headers.get("if-none-match");
        polls.push({ ifNoneMatch });
        return script.poll(polls.length, ifNoneMatch);
      }
      if (url.pathname === "/api/v1/agent/report" && req.method === "POST") {
        reports.push((await req.json()) as Record<string, unknown>);
        return script.report(reports.length);
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
    reports,
    polls,
    wake: () => wakeSocket?.send(JSON.stringify({ type: "pull_now" })),
  };
}

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error("timed out waiting for the loop");
}

describe("runAgentLoop: vulnerability scanning", () => {
  let mock: ReturnType<typeof startScanMock> | undefined;

  afterEach(() => {
    mock?.server.stop(true);
    mock = undefined;
    attestation.clearCachedSession();
  });

  const run = async (
    manager: import("./vulnerability-scan/scan-manager").ScanManager,
    until: () => boolean,
  ) => {
    const controller = new AbortController();
    const loopPromise = loop.runAgentLoop({ signal: controller.signal, scanManager: manager });
    try {
      await waitFor(until);
    } finally {
      controller.abort();
      await expect(loopPromise).rejects.toThrow("agent loop aborted");
    }
  };

  test("reports the installed scanner and an unacknowledged scan, then acknowledges it", async () => {
    const { manager, calls } = fakeScanManager({
      scanner: { name: "trivy", version: "0.75.0" },
      pending: FINISHED_SCAN,
    });
    mock = startScanMock({
      poll: () =>
        Response.json({ version: "v1", packages: [], settings: {} }, { headers: { etag: '"v1"' } }),
      report: () => Response.json({ acknowledged: true }),
    });

    await run(manager, () => calls.acknowledged.length > 0);

    expect(mock.reports[0]?.scanner).toEqual({ name: "trivy", version: "0.75.0" });
    expect(mock.reports[0]?.vulnerabilityScan).toEqual(FINISHED_SCAN);
    expect(calls.acknowledged).toEqual(["scan-1"]);
  }, 15_000);

  test("a report the control plane rejects is not acknowledged, and the scan goes out again", async () => {
    const { manager, calls } = fakeScanManager({ pending: FINISHED_SCAN });
    mock = startScanMock({
      poll: () =>
        Response.json({ version: "v1", packages: [], settings: {} }, { headers: { etag: '"v1"' } }),
      report: (call) =>
        call === 1 ? new Response("boom", { status: 500 }) : Response.json({ acknowledged: true }),
    });

    await run(manager, () => calls.acknowledged.length > 0);

    expect(mock.reports.length).toBeGreaterThanOrEqual(2);
    // The same result, with the same id, on the retry. The control plane drops a repeat.
    expect(mock.reports[0]?.vulnerabilityScan).toEqual(FINISHED_SCAN);
    expect(mock.reports[1]?.vulnerabilityScan).toEqual(FINISHED_SCAN);
    expect(calls.acknowledged).toEqual(["scan-1"]);
  }, 15_000);

  test("leaves both fields out when there is no scanner and no result", async () => {
    const { manager, calls } = fakeScanManager({});
    mock = startScanMock({
      poll: () =>
        Response.json({ version: "v1", packages: [], settings: {} }, { headers: { etag: '"v1"' } }),
      report: () => Response.json({ acknowledged: true }),
    });

    await run(manager, () => (mock?.reports.length ?? 0) > 0 && calls.ticks > 0);

    expect(mock.reports[0]).not.toHaveProperty("scanner");
    expect(mock.reports[0]).not.toHaveProperty("vulnerabilityScan");
    expect(calls.acknowledged).toEqual([]);
  }, 15_000);

  test("keeps the last 200's settings across a 304, and a new 200 replaces them", async () => {
    const { manager, calls } = fakeScanManager({});
    mock = startScanMock({
      poll: (call, ifNoneMatch) => {
        // 1: first poll, a 200 carrying the scan settings.
        if (call === 1) {
          return Response.json(
            { version: "v1", packages: [], settings: SCAN_SETTINGS },
            { headers: { etag: '"a"' } },
          );
        }
        // 2: nothing changed, a 304 with no body.
        if (call === 2) {
          return ifNoneMatch === '"a"'
            ? new Response(null, { status: 304, headers: { etag: '"a"' } })
            : new Response("the agent did not send the ETag back", { status: 500 });
        }
        // 3: changed, and the key is gone: scanning is off.
        return Response.json(
          { version: "v2", packages: [], settings: {} },
          { headers: { etag: '"b"' } },
        );
      },
      report: () => Response.json({ acknowledged: true }),
    });

    const controller = new AbortController();
    const loopPromise = loop.runAgentLoop({ signal: controller.signal, scanManager: manager });
    try {
      await waitFor(() => (mock?.polls.length ?? 0) >= 1 && (mock?.reports.length ?? 0) >= 1);
      for (const target of [2, 3]) {
        // Cut the 30 second sleep short, as the wake fast path does.
        for (let i = 0; i < 100 && (mock?.polls.length ?? 0) < target; i += 1) {
          mock?.wake();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await waitFor(() => (mock?.reports.length ?? 0) >= target);
      }
    } finally {
      controller.abort();
      await expect(loopPromise).rejects.toThrow("agent loop aborted");
    }

    // Handed over on the two 200s only, never on the 304.
    expect(calls.setSettings).toEqual([SCAN_SETTINGS, {}]);
    // But evaluated every cycle, 304 or not, so a scan due between polls still starts.
    expect(calls.ticks).toBeGreaterThanOrEqual(3);
    expect(mock.polls.map((p) => p.ifNoneMatch).slice(0, 3)).toEqual([null, '"a"', '"a"']);
  }, 20_000);
});

// `AGENT_VERSION` is read from `process.env.AGENT_VERSION` at module-evaluation time (see
// poll-report-loop.ts's doc comment), so each case needs its own fresh dynamic import *after*
// setting the env var — same pattern as config.test.ts. Distinct `?case=` cache-busters force
// a fresh module instance per test rather than reusing the plain `./poll-report-loop` instance
// the shared `beforeAll` above already cached for the `runAgentLoop` tests — those two never
// interact, since mutating `process.env` here doesn't retroactively change an already-evaluated
// module's already-frozen constants.
describe("AGENT_VERSION", () => {
  test("falls back to a dev placeholder when --env didn't inline a real one", async () => {
    process.env.CONTROL_PLANE_URL = "https://control-plane.example.test";
    process.env.AGENT_VERSION = undefined;
    // @ts-expect-error — the `?case=` query string is a cache-buster (forces a fresh
    // module instance instead of Bun's cached first import); not a resolvable specifier.
    const { AGENT_VERSION } = await import("./poll-report-loop?case=fallback");
    expect(AGENT_VERSION).toBe("0.0.0-dev");
  });

  test("reports the real value once AGENT_VERSION is set (simulating a bun build --env-inlined binary)", async () => {
    process.env.CONTROL_PLANE_URL = "https://control-plane.example.test";
    process.env.AGENT_VERSION = "1.4.2";
    try {
      // @ts-expect-error — see the fallback-case test above for why this isn't a typo.
      const { AGENT_VERSION } = await import("./poll-report-loop?case=injected");
      expect(AGENT_VERSION).toBe("1.4.2");
    } finally {
      process.env.AGENT_VERSION = undefined;
    }
  });
});
