import { BASE_URL } from "@/lib/api-client";

/**
 * Hand-rolled fetch wrappers around BetterAuth's REST surface
 * (`apps/control-plane/src/auth.ts`, mounted at `/api/auth/*` — see
 * `server.ts`'s `AuthRouteLive`) — no client SDK, matching this codebase's
 * established "no heavy client SDK" style (same as `api-client.ts` itself).
 *
 * Every call needs `credentials: "include"`: the console and control plane
 * are different origins, so the session cookie BetterAuth sets/reads only
 * rides along on a cross-origin request that explicitly asks for it (see
 * `api-client.ts`'s `request()` for the same reasoning).
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
}

export interface AuthSession {
  session: { id: string; expiresAt: string; token: string };
  user: AuthUser;
}

/** Thrown on a non-2xx response from any of these endpoints. */
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

async function extractErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => undefined);
  if (
    body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).message === "string"
  ) {
    return (body as Record<string, unknown>).message as string;
  }
  return `Request failed with status ${res.status}`;
}

/** Real credential check against BetterAuth's `emailAndPassword` provider — throws `AuthError` on invalid credentials. */
export async function signInEmail(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new AuthError(res.status, await extractErrorMessage(res));
  }
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

export async function signOut(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new AuthError(res.status, await extractErrorMessage(res));
  }
}

/** `null` when there's no session — BetterAuth's own `/get-session` never 401s for that case, it returns `null` with a 200. */
export async function getSession(): Promise<AuthSession | null> {
  const res = await fetch(`${BASE_URL}/api/auth/get-session`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new AuthError(res.status, await extractErrorMessage(res));
  }
  return (await res.json()) as AuthSession | null;
}
