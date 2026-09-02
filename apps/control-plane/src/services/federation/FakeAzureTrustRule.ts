// ---------------------------------------------------------------------------
// TEST HARNESS — NOT A REAL INTEGRATION.
//
// No Azure account exists in this build (see `../Signer.azure.ts` and
// `../ProvisioningService.azure.ts` for the same caveat elsewhere). The real
// "does Azure accept this token" check happens entirely inside Entra ID when
// Cloudable's provisioning layer later exchanges the minted JWT for an
// access token — Cloudable never performs that validation itself, and this
// module does not attempt real cryptographic verification against Entra ID.
//
// What this module DOES simulate, faithfully, is the *shape* of the trust
// decision a federated identity credential encodes: "does this token's
// issuer and subject match what I configured?" (see
// `azuread_application_federated_identity_credential` in
// `infra/terraform/federated-credential/main.tf`, whose `issuer`/`subject`
// arguments are exactly `FakeAzureTrustRule.issuer`/`boundSubject` here).
// That's enough to exercise the one property this whole unit exists to
// protect: subject binding as the tenant isolation boundary. Do not wire
// this into any code path that claims to have verified a
// real Azure trust relationship.
// ---------------------------------------------------------------------------
import { Data, Effect } from "effect";
import { MalformedJwtError, decodeJwtPayloadUnsafe } from "./jwt";

/**
 * A customer's federated identity credential, reduced to the two fields
 * that matter for tenant isolation. Mirrors `azuread_application_federated_identity_credential`'s
 * `issuer` and `subject` arguments.
 */
export interface FakeAzureTrustRule {
  readonly issuer: string;
  readonly boundSubject: string;
}

/** Single source of truth for the four rejection reasons — `routes/federation.ts` and `http/handlers/federation.ts` both derive from this instead of redeclaring the list. */
export const TRUST_RULE_REJECTION_REASONS = [
  "malformed_token",
  "expired",
  "issuer_mismatch",
  "subject_mismatch",
] as const;

export type TrustRuleRejectionReason = (typeof TRUST_RULE_REJECTION_REASONS)[number];

export class TrustRuleRejection extends Data.TaggedError("TrustRuleRejection")<{
  reason: TrustRuleRejectionReason;
}> {}

export interface TrustRuleMatch {
  readonly issuer: string;
  readonly subject: string;
}

interface DecodedFederationPayload {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly exp?: unknown;
}

/**
 * Simulates a customer's Azure-side trust check: does this token's `iss`
 * and `sub` match the federated identity credential's configured
 * `issuer`/`subject`? See the module doc comment above for what this is
 * (and is not) a stand-in for.
 *
 * ⚠️ The subject check is the whole point: a rule naming
 * only the issuer would accept a token minted for ANY customer. Never
 * shortcut this to an issuer-only comparison.
 */
export const validateAgainstTrustRule = (
  token: string,
  rule: FakeAzureTrustRule,
): Effect.Effect<TrustRuleMatch, TrustRuleRejection> =>
  Effect.gen(function* () {
    const claims = yield* Effect.try({
      try: () => decodeJwtPayloadUnsafe(token) as DecodedFederationPayload,
      catch: () => new TrustRuleRejection({ reason: "malformed_token" }),
    });

    if (typeof claims.iss !== "string" || typeof claims.sub !== "string") {
      return yield* Effect.fail(new TrustRuleRejection({ reason: "malformed_token" }));
    }

    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      return yield* Effect.fail(new TrustRuleRejection({ reason: "expired" }));
    }

    if (claims.iss !== rule.issuer) {
      return yield* Effect.fail(new TrustRuleRejection({ reason: "issuer_mismatch" }));
    }

    // The tenant isolation boundary: binding on subject,
    // not just issuer, is what stops tenant A's token from validating
    // against tenant B's trust rule.
    if (claims.sub !== rule.boundSubject) {
      return yield* Effect.fail(new TrustRuleRejection({ reason: "subject_mismatch" }));
    }

    return { issuer: claims.iss, subject: claims.sub };
  });

// Re-exported so callers catching decode failures don't need to reach into `./jwt`.
export { MalformedJwtError };
