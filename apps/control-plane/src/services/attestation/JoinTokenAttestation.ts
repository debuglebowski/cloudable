// ---------------------------------------------------------------------------
// Join-token `AttestationMethod` (spec §9): first-class, not a fallback.
// Used by local development, testing, and bare metal (bare metal is
// another provider implementation, not a special case — it has no IMDS to
// hand it a managed-identity token, so it authenticates the same way a dev
// machine does). A join token is a pre-shared secret an org admin
// generates and gives to a machine at boot.
//
// Implemented as a self-contained HMAC-signed opaque string
// (`jt.<payload>.<signature>`, all base64url) rather than a row in a new
// table: verification never needs a database round trip, and this unit
// doesn't have to add a token-storage migration to `packages/schema`
// (owned elsewhere, and not in this unit's file list). The tradeoff: a
// leaked join token can't be revoked individually today — only by rotating
// `JOIN_TOKEN_SECRET`, which invalidates every outstanding token for every
// org at once. Acceptable for this build; worth a real `join_tokens` table
// (hash + `revoked_at`) once per-token revocation is a real requirement.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";
import { Effect, Layer } from "effect";
import {
  AttestationError,
  type AttestationMethod,
  AttestationMethodTag,
  type CredentialClaim,
  type MachineIdentity,
} from "./AttestationMethod";

const PURPOSE = "jt";

const secret = (): string => process.env.JOIN_TOKEN_SECRET ?? "dev-only-change-me";

const sign = (data: string): string =>
  crypto.createHmac("sha256", secret()).update(data).digest("base64url");

interface JoinTokenPayload {
  readonly purpose: typeof PURPOSE;
  readonly orgId: string;
  readonly machineId: string;
  readonly iat: number;
}

const isJoinTokenPayload = (value: unknown): value is JoinTokenPayload => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.purpose === PURPOSE &&
    typeof record.orgId === "string" &&
    typeof record.machineId === "string"
  );
};

/** Best-effort decode for attributing a *rejected* credential in an audit event. Never trusted for authorization. */
const peekClaim = (body: string): { claimedOrgId?: string; claimedMachineId?: string } => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (isJoinTokenPayload(decoded)) {
      return { claimedOrgId: decoded.orgId, claimedMachineId: decoded.machineId };
    }
  } catch {
    // Malformed base64 or JSON — nothing decodable to attribute this to.
  }
  return {};
};

/**
 * The plain `AttestationMethod` object, for callers that need it directly
 * rather than through a `Layer` — e.g. `registry.ts`'s
 * `AttestationRegistryLive`, which composes every method into one map.
 */
export const joinTokenAttestation = {
  method: "join_token",

  issueCredential: (claim: CredentialClaim) =>
    Effect.sync(() => {
      const payload: JoinTokenPayload = {
        purpose: PURPOSE,
        orgId: claim.orgId,
        machineId: claim.machineId,
        iat: Date.now(),
      };
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${PURPOSE}.${body}.${sign(`${PURPOSE}.${body}`)}`;
    }),

  verifyCredential: (credential: string) =>
    Effect.gen(function* () {
      const parts = credential.split(".");
      if (parts.length !== 3 || parts[0] !== PURPOSE) {
        return yield* Effect.fail(new AttestationError({ reason: "malformed_credential" }));
      }
      const [purpose, body, signature] = parts as [string, string, string];

      const expected = Buffer.from(sign(`${purpose}.${body}`));
      const provided = Buffer.from(signature);
      const signatureValid =
        expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
      if (!signatureValid) {
        return yield* Effect.fail(
          new AttestationError({ reason: "invalid_signature", ...peekClaim(body) }),
        );
      }

      const decoded: unknown = yield* Effect.try({
        try: () => JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
        catch: (cause) =>
          new AttestationError({ reason: "malformed_credential", cause, ...peekClaim(body) }),
      });
      if (!isJoinTokenPayload(decoded)) {
        return yield* Effect.fail(
          new AttestationError({ reason: "malformed_credential", ...peekClaim(body) }),
        );
      }

      return { orgId: decoded.orgId, machineId: decoded.machineId } satisfies MachineIdentity;
    }),
} satisfies AttestationMethod;

/** Kept for any caller that still wants join-token as the single, fixed `AttestationMethodTag` (e.g. a unit test). Production dispatch goes through `registry.ts`'s `AttestationRegistryLive` instead, which supports join-token AND managed-identity concurrently. */
export const JoinTokenAttestationLive = Layer.succeed(AttestationMethodTag, joinTokenAttestation);
