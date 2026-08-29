/** Exported so feature units building non-fetch links (e.g. CSV export hrefs) can reuse it. */
export const BASE_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:4780";

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
