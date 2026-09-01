import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearCachedSessionTokenPublicKey, getSessionTokenPublicKey } from "./session-token-key";

const FAKE_RESPONSE = {
  keyId: "session-token",
  publicKeyDerBase64: "fake-key-bytes",
};

const originalFetch = globalThis.fetch;
const originalControlPlaneUrl = process.env.CONTROL_PLANE_URL;

function fakeFetch(callCount: { value: number }, status = 200) {
  return (async (..._args: Parameters<typeof fetch>) => {
    callCount.value += 1;
    if (status !== 200) {
      return new Response(JSON.stringify({ reason: "boom" }), { status });
    }
    return new Response(JSON.stringify(FAKE_RESPONSE), { status: 200 });
  }) as typeof fetch;
}

describe("session-token-key caching", () => {
  beforeEach(() => {
    // `config.ts` is lazy (reads `process.env` on each property access, not once at import) —
    // safe to set this per-test without leaking into other test files' module state.
    process.env.CONTROL_PLANE_URL = "http://localhost:0";
    clearCachedSessionTokenPublicKey();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.CONTROL_PLANE_URL = originalControlPlaneUrl;
    clearCachedSessionTokenPublicKey();
  });

  test("fetches on first call and caches the result", async () => {
    const calls = { value: 0 };
    globalThis.fetch = fakeFetch(calls);

    const first = await getSessionTokenPublicKey("bearer-1");
    expect(first).toEqual(FAKE_RESPONSE);
    expect(calls.value).toBe(1);
  });

  test("a second call within the TTL returns the cached value without a new fetch", async () => {
    const calls = { value: 0 };
    globalThis.fetch = fakeFetch(calls);

    await getSessionTokenPublicKey("bearer-1");
    const second = await getSessionTokenPublicKey("bearer-1");

    expect(second).toEqual(FAKE_RESPONSE);
    expect(calls.value).toBe(1); // still just the one fetch
  });

  test("clearCachedSessionTokenPublicKey() forces the next call to re-fetch", async () => {
    const calls = { value: 0 };
    globalThis.fetch = fakeFetch(calls);

    await getSessionTokenPublicKey("bearer-1");
    clearCachedSessionTokenPublicKey();
    await getSessionTokenPublicKey("bearer-1");

    expect(calls.value).toBe(2);
  });

  test("a non-ok response throws ApiError and does not cache anything", async () => {
    const calls = { value: 0 };
    globalThis.fetch = fakeFetch(calls, 401);

    await expect(getSessionTokenPublicKey("bad-bearer")).rejects.toMatchObject({ status: 401 });

    // The failed attempt must not have poisoned the cache — the next call retries the
    // network rather than "successfully" returning nothing forever.
    globalThis.fetch = fakeFetch(calls, 200);
    const result = await getSessionTokenPublicKey("bearer-1");
    expect(result).toEqual(FAKE_RESPONSE);
    expect(calls.value).toBe(2);
  });
});
