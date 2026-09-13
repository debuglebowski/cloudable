// ---------------------------------------------------------------------------
// Every request this CLI makes. Two entry points: `apiRequest` for the one
// flow that carries its own credential (`cloudable login`'s signed code) and
// `authenticatedApiRequest` for everything else, which sends the session
// cookie `cloudable auth login` stored.
//
// Failures arrive as three different shapes depending on which layer refused
// — Effect's tagged errors, the access routes' `{code, message}`, and
// BetterAuth's `{message}` — so `describe` reads all three rather than
// printing "API error 409" and leaving the reason in a response nobody sees.
// ---------------------------------------------------------------------------
import { config } from "./config";
import { EXIT } from "./errors";
import { requireSession } from "./session";

function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT.unauthenticated;
  if (status === 403) return EXIT.denied;
  if (status === 404) return EXIT.notFound;
  if (status === 409 || status === 422) return EXIT.conflict;
  if (status >= 500) return EXIT.serverError;
  return EXIT.failure;
}

function describe(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;

    const wrapped = record.error;
    if (typeof wrapped === "object" && wrapped !== null) {
      const inner = wrapped as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    if (typeof record.message === "string" && record.message !== "") return record.message;

    // An Effect tagged error: the tag is the reason, the rest is the detail.
    if (typeof record._tag === "string") {
      const detail = Object.entries(record)
        .filter(([key, value]) => key !== "_tag" && value !== null && value !== undefined)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ");
      return detail === "" ? record._tag : `${record._tag} (${detail})`;
    }
    if (typeof record.reason === "string") return record.reason;
  }
  if (typeof body === "string" && body.trim() !== "") return body.trim();
  return `the control plane answered ${status}`;
}

export class ApiError extends Error {
  readonly exitCode: number;
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(describe(status, body));
    this.exitCode = exitCodeForStatus(status);
  }
}

/** A control plane that cannot be reached is a different problem from one that refused. */
export class NetworkError extends Error {
  readonly exitCode = EXIT.unreachable;
  constructor(url: string, cause: unknown) {
    super(
      `could not reach ${url}\n\n${cause instanceof Error ? cause.message : String(cause)}\n\nCheck CLOUDABLE_API_URL and that the control plane is up.`,
    );
  }
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const url = `${config.apiUrl}${path}`;
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new NetworkError(url, cause);
  }
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// No auth header by default — used by flows that aren't session-scoped
// (`cloudable login`'s SSH-certificate issuance, which authenticates via a
// one-shot signed `code` in the request body instead — see `login.ts`).
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await bodyOf(res));
  return res.json() as Promise<T>;
}

/** Same as `apiRequest`, but attaches the real BetterAuth session cookie from
 * `cloudable auth login` (see `session.ts`) — for every endpoint that now
 * requires a real session (`http/middleware/auth.ts`), which is most of
 * them. Throws a clear "not logged in" error if there's no stored session,
 * rather than letting the request 401 with no context. */
export async function authenticatedApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const session = requireSession();
  return apiRequest<T>(path, {
    ...init,
    headers: { Cookie: session.cookie, ...init?.headers },
  });
}

/** For the CSV exports, which answer `text/csv` rather than JSON. */
export async function authenticatedApiText(path: string): Promise<string> {
  const session = requireSession();
  const res = await send(path, { headers: { Cookie: session.cookie } });
  if (!res.ok) throw new ApiError(res.status, await bodyOf(res));
  return res.text();
}

/** Skips absent values, so a caller can pass optional params straight through. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

export function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export function patchJson(body: unknown): RequestInit {
  return { method: "PATCH", body: JSON.stringify(body) };
}
