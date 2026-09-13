// ---------------------------------------------------------------------------
// The CLI's API credential: a signed bearer token `cloudable login` receives
// alongside its SSH certificate, sent as `Authorization: Bearer` on every
// subsequent call (see `http/middleware/auth.ts`).
//
// Replaces the BetterAuth session cookie the CLI used to obtain by posting
// an email and password to `/api/auth/sign-in/email` itself. That path is
// gone: a CLI that prompts for a password is a CLI that can be pointed at a
// phishing host, it bypasses SSO entirely (an org that connected SAML could
// still hand out passwords), and it put the password in argv, so in shell
// history and the process table. Password sign-in still exists — it just
// happens in the browser, at the console's `/login`, where SSO is also on
// offer. See `docs/access.md`.
//
// Same shape and reasoning as `CliAuthCode.ts` and
// `attestation/JoinTokenAttestation.ts`: HMAC-signed, self-contained, no new
// table and no DB round trip to verify. The tradeoff is the same one those
// two document — an individual token cannot be revoked, only the secret
// rotated. Two things bound that here:
//
//   - The token carries a `personId` and nothing else. Org, role and email
//     are resolved from the live `people` row on every request, so a token
//     is only ever as privileged as its person is right now.
//   - Offboarding deletes that row, which kills every token that person
//     holds on the next request. That is the revocation path that matters,
//     and it is immediate rather than TTL-bounded.
//
// Distinct secret from `CLI_AUTH_CODE_SECRET`: that one signs a 60-second
// single-purpose code, this one signs a 30-day API credential. Different
// blast radius, so different secret and independent rotation.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";

const PURPOSE = "cli-token";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const CLI_TOKEN_TTL_MS = TTL_MS;

const secret = (): string => process.env.CLI_TOKEN_SECRET ?? "dev-only-change-me";

const sign = (data: string): string =>
  crypto.createHmac("sha256", secret()).update(data).digest("base64url");

interface CliTokenPayload {
  readonly purpose: typeof PURPOSE;
  readonly personId: string;
  readonly iat: number;
}

const isCliTokenPayload = (value: unknown): value is CliTokenPayload => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.purpose === PURPOSE &&
    typeof record.personId === "string" &&
    typeof record.iat === "number"
  );
};

export const issueCliToken = (input: { personId: string }): string => {
  const payload: CliTokenPayload = {
    purpose: PURPOSE,
    personId: input.personId,
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${PURPOSE}.${body}.${sign(`${PURPOSE}.${body}`)}`;
};

export type CliTokenError =
  | { reason: "malformed_token" }
  | { reason: "invalid_signature" }
  | { reason: "expired" };

export const verifyCliToken = (
  token: string,
): { ok: true; personId: string } | { ok: false; error: CliTokenError } => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PURPOSE) {
    return { ok: false, error: { reason: "malformed_token" } };
  }
  const [purpose, body, signature] = parts as [string, string, string];

  // Signature before anything else: an attacker must not learn that the
  // claims were well-formed, or that they had expired, from a token whose
  // signature does not check out. Same ordering `tunnel/session-token.ts`
  // documents.
  const expected = Buffer.from(sign(`${purpose}.${body}`));
  const provided = Buffer.from(signature);
  const signatureValid =
    expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  if (!signatureValid) {
    return { ok: false, error: { reason: "invalid_signature" } };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: { reason: "malformed_token" } };
  }
  if (!isCliTokenPayload(decoded)) {
    return { ok: false, error: { reason: "malformed_token" } };
  }
  if (Date.now() - decoded.iat > TTL_MS) {
    return { ok: false, error: { reason: "expired" } };
  }

  return { ok: true, personId: decoded.personId };
};
