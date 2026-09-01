import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { TRUST_RULE_REJECTION_REASONS } from "../../services/federation/FakeAzureTrustRule";
import { CurrentUserAuthentication } from "../middleware/auth";

/**
 * OIDC discovery document (`GET /.well-known/openid-configuration`). Only
 * the fields a workload-identity-federation consumer (Entra ID) actually
 * needs — see docs/cloud-auth.md for the full flow.
 */
export const OidcDiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
  response_types_supported: Schema.Array(Schema.String),
  subject_types_supported: Schema.Array(Schema.String),
  id_token_signing_alg_values_supported: Schema.Array(Schema.String),
});

/** A single Ed25519 signing key in JWK form. */
export const FederationJwk = Schema.Struct({
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  x: Schema.String,
  use: Schema.Literal("sig"),
  alg: Schema.Literal("EdDSA"),
  kid: Schema.String,
});

/** `GET /.well-known/jwks.json` response. */
export const JwksDocument = Schema.Struct({
  keys: Schema.Array(FederationJwk),
});

/**
 * Error response bodies for this group, mirroring `@cloudable/contracts`'
 * `ApiErrorBody` shape (kept local so this route file has no dependency
 * beyond `@effect/platform`/`effect`) plus a required `kind` discriminant.
 *
 * The discriminant matters: `@effect/platform` resolves the API's overall
 * error union by *schema shape*, pooled across every endpoint in the
 * `HttpApi`, not scoped per-endpoint — and `Schema.Struct` encoding
 * silently drops fields a schema doesn't declare rather than failing. Two
 * error schemas where one's required fields are a subset of the other's
 * would therefore collide (the subset schema matches ANY value that also
 * satisfies the superset one, so whichever is checked first always wins,
 * regardless of registration order or which endpoint actually failed) and
 * the more specific status/shape would never be reached. A required `kind`
 * literal that differs between them makes the two mutually exclusive, so
 * resolution is correct regardless of iteration order.
 */
export const FederationErrorResponse = Schema.Struct({
  kind: Schema.Literal("infra_error"),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    requestId: Schema.String,
  }),
});

/** The reasons `FakeAzureTrustRule.validateAgainstTrustRule` can reject a token — derived from `TRUST_RULE_REJECTION_REASONS`, the single source of truth. */
const RejectionReason = Schema.Literal(...TRUST_RULE_REJECTION_REASONS);

export const FederationRejectedResponse = Schema.Struct({
  kind: Schema.Literal("rejected"),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    requestId: Schema.String,
  }),
  reason: RejectionReason,
});

const TrustRule = Schema.Struct({
  issuer: Schema.String,
  boundSubject: Schema.String,
});

/**
 * Request body for the mint endpoint. `trustRule` stands in for the
 * customer's Azure-side federated identity credential configuration — see
 * `services/federation/FakeAzureTrustRule.ts` for exactly what it does (and
 * does not) validate; no real Azure account exists in this build.
 *
 * Deliberately does NOT include `orgId` — this endpoint mints a real,
 * production-Key-Vault-signed credential and persists an `integrations`
 * row for whatever org it's told to, so `orgId` must come from the
 * authenticated caller's own session (`CurrentUserTag`, see
 * `../handlers/federation.ts`), never from the request body. An earlier
 * version of this schema took `orgId` from the client directly while the
 * `mint` endpoint itself had no auth middleware at all — together, that let
 * any unauthenticated caller mint a validly-signed federation token for a
 * customer id of their choosing and overwrite another org's `integrations`
 * row with attacker-supplied `subscriptionId`/`trustRule` values.
 */
export const MintFederationTokenRequest = Schema.Struct({
  customerId: Schema.String,
  subscriptionId: Schema.String,
  trustRule: TrustRule,
});

export const MintFederationTokenResponse = Schema.Struct({
  subject: Schema.String,
  subscriptionId: Schema.String,
  token: Schema.String,
});

/**
 * Well-known OIDC endpoints plus the per-customer mint endpoint (docs/spec.md
 * §10). The `.well-known/...` paths are spec-mandated absolute paths, not
 * versioned `/api/v1/...` routes, and must stay public — Azure fetches them
 * directly with no Cloudable session of any kind.
 *
 * Per-endpoint (not whole-group) `.middleware(CurrentUserAuthentication)` on
 * `mint` only, same convention `../routes/access.ts` uses for its own mix of
 * authenticated and unauthenticated endpoints: `mint` is an on-demand admin
 * action ("verify my Azure federation setup", docs/cloud-auth.md's "at
 * provisioning time — or on demand, via the mint endpoint") acting on the
 * caller's own org, not a public OIDC-protocol endpoint like its two
 * siblings here.
 */
export const FederationGroup = HttpApiGroup.make("federation")
  .add(
    HttpApiEndpoint.get("discovery", "/.well-known/openid-configuration").addSuccess(
      OidcDiscoveryDocument,
    ),
  )
  .add(
    HttpApiEndpoint.get("jwks", "/.well-known/jwks.json")
      .addSuccess(JwksDocument)
      .addError(FederationErrorResponse, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("mint", "/api/v1/federation/mint")
      .setPayload(MintFederationTokenRequest)
      .addSuccess(MintFederationTokenResponse)
      .addError(FederationRejectedResponse, { status: 422 })
      .addError(FederationErrorResponse, { status: 500 })
      .middleware(CurrentUserAuthentication),
  );
