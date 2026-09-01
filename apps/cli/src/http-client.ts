import { config } from "./config";
import { requireSession } from "./session";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

// No auth header by default — used by flows that aren't session-scoped
// (`cloudable login`'s dev-mode SSH-certificate issuance).
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
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
