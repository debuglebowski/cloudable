import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, apiGet, setUnauthorizedHandler } from "./api-client";

const mockFetchOnce = (status: number, body: unknown) => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
};

/**
 * Regression coverage for two related bugs in `request()`'s 401 handling:
 *
 * 1. A 401 for an actually-expired session (`AuthenticationRequired` /
 *    `"no_session"`) must fire the registered `onUnauthorized` handler
 *    (`main.tsx` wires this to logging the console out), not just render as
 *    a page's own inline error with no route change.
 * 2. A 401 for `"no_matching_person"` (a valid session whose account has no
 *    `people` row — a standing condition, not an expired one) must NOT fire
 *    it: re-checking the session always succeeds again for this case, so
 *    treating it the same as `"no_session"` produces a `/` ⇄ `/login`
 *    redirect loop instead of a one-time sign-out.
 */
describe("api-client 401 handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(() => {});
  });

  test("an expired-session 401 fires the registered unauthorized handler", async () => {
    mockFetchOnce(401, { _tag: "AuthenticationRequired", reason: "no_session" });

    let fired = false;
    setUnauthorizedHandler(() => {
      fired = true;
    });

    await expect(apiGet("/api/v1/machines")).rejects.toThrow(ApiError);
    expect(fired).toBe(true);
  });

  test("a no-matching-person 401 does NOT fire the unauthorized handler (would loop otherwise)", async () => {
    mockFetchOnce(401, { _tag: "AuthenticationRequired", reason: "no_matching_person" });

    let fired = false;
    setUnauthorizedHandler(() => {
      fired = true;
    });

    await expect(apiGet("/api/v1/machines")).rejects.toThrow(ApiError);
    expect(fired).toBe(false);
  });

  test("a non-401 error response does not fire the unauthorized handler", async () => {
    mockFetchOnce(500, { error: "boom" });

    let fired = false;
    setUnauthorizedHandler(() => {
      fired = true;
    });

    await expect(apiGet("/api/v1/machines")).rejects.toThrow(ApiError);
    expect(fired).toBe(false);
  });

  test("a successful response does not fire the unauthorized handler", async () => {
    mockFetchOnce(200, { items: [] });

    let fired = false;
    setUnauthorizedHandler(() => {
      fired = true;
    });

    await apiGet("/api/v1/machines");
    expect(fired).toBe(false);
  });
});
