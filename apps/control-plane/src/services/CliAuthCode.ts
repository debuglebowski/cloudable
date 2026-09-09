// ---------------------------------------------------------------------------
// Short-lived, self-contained HMAC-signed code `cloudable login` exchanges
// for `{ personId, orgId }` — the real replacement for the dev-only
// `--dev-person-id`/`--org-id` flags (see `apps/cli/src/login.ts`).
//
// Same shape and reasoning as `attestation/JoinTokenAttestation.ts`'s join
// token: no new table, no DB round trip to verify, verification is a pure
// signature+expiry check. The tradeoff there (a leaked token can't be
// revoked individually, only by rotating the secret) matters far less
// here — a 60s TTL bounds exposure on its own, and each code is single-
// purpose (one `issueCertificate` call), never a reusable session.
//
// Not the same secret as `JOIN_TOKEN_SECRET`: that signs machine-identity
// credentials, this signs person-identity ones — different purposes,
// different blast radius if either leaks or rotates.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";

const PURPOSE = "cli";
const TTL_MS = 60_000;

const secret = (): string => process.env.CLI_AUTH_CODE_SECRET ?? "dev-only-change-me";

const sign = (data: string): string =>
  crypto.createHmac("sha256", secret()).update(data).digest("base64url");

interface CliAuthCodePayload {
  readonly purpose: typeof PURPOSE;
  readonly personId: string;
  readonly orgId: string;
  readonly iat: number;
}

const isCliAuthCodePayload = (value: unknown): value is CliAuthCodePayload => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.purpose === PURPOSE &&
    typeof record.personId === "string" &&
    typeof record.orgId === "string" &&
    typeof record.iat === "number"
  );
};

export const issueCliAuthCode = (input: { personId: string; orgId: string }): string => {
  const payload: CliAuthCodePayload = {
    purpose: PURPOSE,
    personId: input.personId,
    orgId: input.orgId,
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${PURPOSE}.${body}.${sign(`${PURPOSE}.${body}`)}`;
};

export type CliAuthCodeError =
  | { reason: "malformed_code" }
  | { reason: "invalid_signature" }
  | { reason: "expired" };

export const verifyCliAuthCode = (
  code: string,
): { ok: true; personId: string; orgId: string } | { ok: false; error: CliAuthCodeError } => {
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== PURPOSE) {
    return { ok: false, error: { reason: "malformed_code" } };
  }
  const [purpose, body, signature] = parts as [string, string, string];

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
    return { ok: false, error: { reason: "malformed_code" } };
  }
  if (!isCliAuthCodePayload(decoded)) {
    return { ok: false, error: { reason: "malformed_code" } };
  }
  if (Date.now() - decoded.iat > TTL_MS) {
    return { ok: false, error: { reason: "expired" } };
  }

  return { ok: true, personId: decoded.personId, orgId: decoded.orgId };
};
