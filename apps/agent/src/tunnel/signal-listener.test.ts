import { describe, expect, test } from "bun:test";
import { runTunnelSignalLoop } from "./signal-listener";

/** A `fetch`-shaped fake returning one scripted response per call, in order — the last
 * response repeats for any call past the end of the script (keeps a still-running loop fed
 * something plausible after the test's own assertions have already captured what they need). */
function fakeFetch(responses: ReadonlyArray<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async () => {
    const index = Math.min(calls, responses.length - 1);
    calls += 1;
    const response = responses[index];
    if (!response) throw new Error("no fake response configured");
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const fakeAttest = () => Promise.resolve({ bearerToken: "test-bearer-token" });

/** Runs the loop until it has completed at least `n` fetch calls, then aborts it — lets a
 * test assert on exactly the calls/callbacks it cares about without the loop running forever
 * (it only ever stops via `options.signal`, by design — see the loop's own doc comment). */
async function runUntil(
  n: number,
  fetchImpl: typeof fetch,
  callbacks: { onSessionWaiting: (id: string) => void; onSessionTerminate: (id: string) => void },
  sleep: (ms: number) => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const controller = new AbortController();
  let completed = 0;
  const countingFetch = (async (...args: Parameters<typeof fetch>) => {
    const result = await (fetchImpl as (...a: Parameters<typeof fetch>) => Promise<Response>)(
      ...args,
    );
    completed += 1;
    if (completed >= n) controller.abort();
    return result;
  }) as unknown as typeof fetch;

  await runTunnelSignalLoop(
    callbacks,
    { fetchImpl: countingFetch, attest: fakeAttest, sleep },
    { signal: controller.signal },
  ).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== "tunnel signal loop aborted") throw error;
  });
}

describe("runTunnelSignalLoop", () => {
  test("a session_waiting signal calls onSessionWaiting with the session id", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { signal: { type: "session_waiting", sessionId: "s-1" } } },
    ]);
    const waiting: string[] = [];
    const terminate: string[] = [];
    await runUntil(1, fetchImpl, {
      onSessionWaiting: (id) => waiting.push(id),
      onSessionTerminate: (id) => terminate.push(id),
    });
    expect(waiting).toEqual(["s-1"]);
    expect(terminate).toEqual([]);
  });

  test("a session_terminate signal calls onSessionTerminate with the session id", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { signal: { type: "session_terminate", sessionId: "s-2" } } },
    ]);
    const waiting: string[] = [];
    const terminate: string[] = [];
    await runUntil(1, fetchImpl, {
      onSessionWaiting: (id) => waiting.push(id),
      onSessionTerminate: (id) => terminate.push(id),
    });
    expect(terminate).toEqual(["s-2"]);
    expect(waiting).toEqual([]);
  });

  test("signal: null (a clean long-poll timeout) calls neither callback and loops again immediately", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { signal: null } },
      { status: 200, body: { signal: null } },
      { status: 200, body: { signal: { type: "session_waiting", sessionId: "s-3" } } },
    ]);
    const waiting: string[] = [];
    let sleptAtAll = false;
    await runUntil(
      3,
      fetchImpl,
      { onSessionWaiting: (id) => waiting.push(id), onSessionTerminate: () => {} },
      async () => {
        sleptAtAll = true;
      },
    );
    expect(calls()).toBe(3);
    expect(waiting).toEqual(["s-3"]);
    // No failure occurred across any of the three calls, so the backoff `sleep` should never
    // have been invoked — looping on a clean timeout is immediate, not throttled.
    expect(sleptAtAll).toBe(false);
  });

  test("a malformed response body is treated as no signal, not a thrown error", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { unexpected: "shape" } },
      { status: 200, body: { signal: { type: "session_waiting", sessionId: "s-4" } } },
    ]);
    const waiting: string[] = [];
    await runUntil(2, fetchImpl, {
      onSessionWaiting: (id) => waiting.push(id),
      onSessionTerminate: () => {},
    });
    // The malformed first response didn't crash the loop or misfire a callback — only the
    // second, well-formed response produced a callback call.
    expect(waiting).toEqual(["s-4"]);
  });

  test("a non-401 HTTP error backs off before retrying, then recovers", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 500, body: { code: "internal_error", message: "boom" } },
      { status: 200, body: { signal: { type: "session_waiting", sessionId: "s-5" } } },
    ]);
    const waiting: string[] = [];
    const sleeps: number[] = [];
    await runUntil(
      2,
      fetchImpl,
      { onSessionWaiting: (id) => waiting.push(id), onSessionTerminate: () => {} },
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(waiting).toEqual(["s-5"]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
  });

  test("an already-aborted signal stops the loop before ever calling fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("should never be called");
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await expect(
      runTunnelSignalLoop(
        { onSessionWaiting: () => {}, onSessionTerminate: () => {} },
        { fetchImpl, attest: fakeAttest },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("tunnel signal loop aborted");
    expect(fetchCalls).toBe(0);
  });
});
