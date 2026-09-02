import { integrations } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { ulid } from "ulid";
import { AppConfigTag } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../EventBus";
import { SignerTag } from "../Signer";
import {
  type FakeAzureTrustRule,
  type TrustRuleRejectionReason,
  validateAgainstTrustRule,
} from "./FakeAzureTrustRule";
import { type Ed25519Jwk, ed25519SpkiDerToJwk } from "./jwk";
import { type FederationClaims, assembleJws, encodeSigningInput } from "./jwt";

/** Key id the federation signing key is stored under in the `Signer` port. Distinct from any CA/SSH-cert signing key another unit may add. */
export const FEDERATION_KEY_ID = "federation-oidc-v1";

/** ~1h, matching how long Azure validates and returns an access token for — the minted OIDC token itself is short-lived to match. */
const TOKEN_TTL_SECONDS = 60 * 60;

/** The exact subject format — this string is the tenant isolation boundary, see `FakeAzureTrustRule.ts`. */
export const subjectForCustomer = (customerId: string): string => `cloudable:tenant:${customerId}`;

export class FederationError extends Data.TaggedError("FederationError")<{
  reason: TrustRuleRejectionReason | "sign_failed" | "persist_failed";
  cause?: unknown;
}> {}

export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly response_types_supported: ReadonlyArray<string>;
  readonly subject_types_supported: ReadonlyArray<string>;
  readonly id_token_signing_alg_values_supported: ReadonlyArray<string>;
}

export interface JwksDocument {
  readonly keys: ReadonlyArray<Ed25519Jwk>;
}

export interface FederateCredentialInput {
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  /**
   * Stand-in for the customer's actual Azure-side configuration — see
   * `FakeAzureTrustRule.ts`'s module doc comment for exactly what this is
   * (and is not) simulating.
   */
  readonly trustRule: FakeAzureTrustRule;
  readonly correlationId?: string;
}

export interface FederationOutcome {
  readonly subject: string;
  readonly subscriptionId: string;
  readonly token: string;
}

/**
 * Workload identity federation (see `docs/cloud-auth.md`):
 * the OIDC issuer (discovery doc + JWKS) and per-customer token minting.
 * One eventual real implementation, not a swappable port — modeled
 * directly as an `Effect.Service`, same as `ApprovalService`.
 */
export class FederationService extends Effect.Service<FederationService>()("FederationService", {
  effect: Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const signer = yield* SignerTag;
    const config = yield* AppConfigTag;

    const discoveryDocument = (): Effect.Effect<OidcDiscoveryDocument> =>
      Effect.succeed({
        issuer: config.federationIssuerUrl,
        jwks_uri: `${config.federationIssuerUrl}/.well-known/jwks.json`,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["EdDSA"],
      });

    const jwks = (): Effect.Effect<JwksDocument, FederationError> =>
      Effect.gen(function* () {
        const der = yield* signer
          .publicKey(FEDERATION_KEY_ID)
          .pipe(Effect.mapError((cause) => new FederationError({ reason: "sign_failed", cause })));
        return { keys: [ed25519SpkiDerToJwk(der, FEDERATION_KEY_ID)] };
      });

    /** Mints a short-lived, per-customer-subject federation token. */
    const mintFederationToken = (customerId: string): Effect.Effect<string, FederationError> =>
      Effect.gen(function* () {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "EdDSA" as const, typ: "JWT" as const, kid: FEDERATION_KEY_ID };
        const payload: FederationClaims = {
          iss: config.federationIssuerUrl,
          sub: subjectForCustomer(customerId),
          aud: config.federationAudience,
          iat: now,
          exp: now + TOKEN_TTL_SECONDS,
        };
        const signingInput = encodeSigningInput(header, payload);
        const signature = yield* signer
          .sign({
            keyId: FEDERATION_KEY_ID,
            algorithm: "ed25519",
            data: new TextEncoder().encode(signingInput),
          })
          .pipe(Effect.mapError((cause) => new FederationError({ reason: "sign_failed", cause })));
        return assembleJws(signingInput, signature);
      });

    /**
     * Mints a token, then attempts to establish federation for it —
     * persisting an `integrations` row and emitting `cloud.credential_federated`
     * on success, or emitting `cloud.credential_rejected` (ALWAYS — this is
     * a tier-1, always-alert security event, never swallowed) and failing
     * on rejection.
     *
     * The "attempt" step stands in for the real Azure OIDC token exchange
     * (see `FakeAzureTrustRule.ts`) — no Azure account exists in this
     * build. Swap that one call for a real token-exchange request once one
     * does; the persist/emit contract either side of it does not change.
     */
    const federateCredential = (
      input: FederateCredentialInput,
    ): Effect.Effect<FederationOutcome, FederationError> =>
      Effect.gen(function* () {
        const subject = subjectForCustomer(input.customerId);
        const correlationId = input.correlationId ?? ulid();
        const envelopeBase = {
          // `id`/`recordedAt` are placeholders — `EventBus.publish` always
          // overwrites both with a fresh ULID/timestamp (see its doc comment).
          id: ulid(),
          recordedAt: new Date(),
          occurredAt: new Date(),
          orgId: input.orgId,
          actorType: "system" as const,
          actorId: "federation-service",
          machineId: null,
          correlationId,
          schemaVersion: 1,
        };

        const token = yield* mintFederationToken(input.customerId);
        const validation = yield* validateAgainstTrustRule(token, input.trustRule).pipe(
          Effect.either,
        );

        if (validation._tag === "Left") {
          const reason = validation.left.reason;
          // Always alert on rejection (docs/events.md: `cloud.credential_rejected`
          // is a tier-1, always-audited security event) — emitted unconditionally
          // before failing, never swallowed. A failure to even PUBLISH that
          // event is a `persist_failed` infra fault in its own right, not
          // another instance of the trust-rule rejection `reason` — conflating
          // the two would make the mint endpoint report an event-bus outage
          // as an ordinary 422 rejection instead of a 500.
          yield* eventBus
            .publish([
              { ...envelopeBase, type: "cloud.credential_rejected", payload: { subject, reason } },
            ])
            .pipe(
              Effect.mapError((cause) => new FederationError({ reason: "persist_failed", cause })),
            );
          return yield* Effect.fail(new FederationError({ reason }));
        }

        // Upsert by hand rather than a DB-level `onConflictDoUpdate`: minting
        // is expected to be called repeatedly for the same customer (tokens
        // are only ~1h TTL), and `integrations` has no unique constraint to
        // use as a conflict target — re-federating should update the
        // existing row (and un-remove it, if it had been revoked) rather
        // than accumulate duplicates.
        const integrationConfig = {
          issuer: config.federationIssuerUrl,
          subject,
          subscriptionId: input.subscriptionId,
        };
        const existing = yield* Effect.tryPromise({
          try: () =>
            db
              .select({ id: integrations.id })
              .from(integrations)
              .where(
                and(
                  eq(integrations.orgId, input.orgId),
                  eq(integrations.kind, "cloud"),
                  eq(integrations.identifier, subject),
                ),
              )
              .limit(1),
          catch: (cause) => new FederationError({ reason: "persist_failed", cause }),
        });
        yield* Effect.tryPromise({
          try: () =>
            existing[0]
              ? db
                  .update(integrations)
                  .set({ config: integrationConfig, removedAt: null })
                  .where(eq(integrations.id, existing[0].id))
              : db.insert(integrations).values({
                  orgId: input.orgId,
                  kind: "cloud",
                  identifier: subject,
                  config: integrationConfig,
                }),
          catch: (cause) => new FederationError({ reason: "persist_failed", cause }),
        });

        yield* eventBus
          .publish([
            {
              ...envelopeBase,
              type: "cloud.credential_federated",
              payload: { subject, subscriptionId: input.subscriptionId },
            },
          ])
          .pipe(
            Effect.mapError((cause) => new FederationError({ reason: "persist_failed", cause })),
          );

        return { subject, subscriptionId: input.subscriptionId, token };
      });

    return { discoveryDocument, jwks, mintFederationToken, federateCredential } as const;
  }),
}) {}
