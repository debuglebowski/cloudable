/** Exported so feature units building non-fetch links (e.g. CSV export hrefs) can reuse it. */
export const BASE_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:4780";

/**
 * Fires on a 401 whose body is the control plane's own `AuthenticationRequired`
 * with `reason: "no_session"` — a session that was valid when `root.tsx`'s
 * guard last checked it (or was never checked yet on this exact call) but has
 * since expired or gone stale server-side. `main.tsx` wires this to clearing
 * the session query, which flips that guard and sends the whole app to
 * `/login`, same as an explicit sign-out.
 *
 * Deliberately narrower than "any 401": the middleware's other reason,
 * `"no_matching_person"`, means the signed-in BetterAuth session is valid but
 * that account has no `people` row — re-checking the session (what clearing
 * it here triggers) always succeeds again, since the session itself never
 * expired, which flips `root.tsx`'s guard straight back to authenticated and
 * the next machines fetch straight back to 401 — a "home ⇄ /login" loop
 * instead of the intended one-time redirect. That case surfaces as this
 * page's own inline error instead, same as any other 401 not covered here.
 */
let onUnauthorized: (() => void) | undefined;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

function isExpiredSession(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>)._tag === "AuthenticationRequired" &&
    (body as Record<string, unknown>).reason === "no_session"
  );
}

/**
 * Thrown on any non-2xx response. `body` carries the parsed JSON error body
 * when the response actually returned one (every real control-plane
 * endpoint's `{ error: { code, message, ... } }` shape, or a handler-
 * specific shape like Access's `{ code, message }`) — `undefined` when the
 * response wasn't JSON at all. Callers that need the structured reason (not
 * just a display string) should catch `ApiError` specifically rather than
 * parsing `.message`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, path: string, method: string, body: unknown) {
    const detail = extractMessage(body);
    super(detail ? `${method} ${path} -> ${status}: ${detail}` : `${method} ${path} -> ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    const err = obj.error;
    if (
      err &&
      typeof err === "object" &&
      typeof (err as Record<string, unknown>).message === "string"
    ) {
      return (err as Record<string, unknown>).message as string;
    }
  }
  return undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // The control plane and console are different origins (see
    // `vite.config.ts`'s pinned dev port and `CONSOLE_ORIGIN` in the
    // control plane's own config) — a BetterAuth session cookie only rides
    // along on a cross-origin request that explicitly asks for it.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res
      .clone()
      .json()
      .catch(() => undefined);
    if (res.status === 401 && isExpiredSession(body)) {
      onUnauthorized?.();
    }
    throw new ApiError(res.status, path, method, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

/** Feature units' src/api/<domain>.ts files build on top of these. */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
