// ---------------------------------------------------------------------------
// `cloudable auth login`/`auth logout` — email/password sign-in against the
// real control plane's BetterAuth instance (`apps/control-plane/src/auth.ts`,
// mounted at `/api/auth/*`), the same credential check the console's login
// page uses. Distinct from `cloudable login`'s SSH-certificate flow — see
// `session.ts`'s header comment for why these are two mechanisms, not one.
// ---------------------------------------------------------------------------
import { config } from "./config";
import { promptPassword, promptText } from "./prompt";
import { clearSession, loadSession, saveSession } from "./session";

interface SignInResponse {
  user: { email: string };
}

function cookieHeaderFromSetCookies(setCookies: ReadonlyArray<string>): string {
  return setCookies
    .filter(Boolean)
    .map((sc) => sc.split(";")[0])
    .join("; ");
}

export async function authLogin(email: string, password: string): Promise<string> {
  const res = await fetch(`${config.apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    const message =
      body &&
      typeof body === "object" &&
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `sign-in failed with status ${res.status}`;
    throw new Error(message);
  }
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const cookie = cookieHeaderFromSetCookies(setCookies);
  if (!cookie) throw new Error("sign-in succeeded but no session cookie was returned");
  const body = (await res.json()) as SignInResponse;
  saveSession({ cookie, email: body.user.email });
  return body.user.email;
}

export async function runAuthLoginCommand(argv: ReadonlyArray<string>): Promise<void> {
  const email = argv[0] ?? (await promptText("Email: "));
  const password = argv[1] ?? (await promptPassword("Password: "));
  const signedInEmail = await authLogin(email, password);
  console.log(`Signed in as ${signedInEmail}.`);
}

export function runAuthLogoutCommand(): void {
  const existing = loadSession();
  clearSession();
  console.log(existing ? `Signed out ${existing.email}.` : "Not signed in.");
}

export function runAuthStatusCommand(): void {
  const session = loadSession();
  console.log(session ? `Signed in as ${session.email}.` : "Not signed in.");
}
