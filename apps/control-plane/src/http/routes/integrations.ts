import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { CurrentUserAuthentication } from "../middleware/auth";

const IntegrationKind = Schema.Literal("idp", "cloud", "secret_store");
const IntegrationProvider = Schema.Literal("azure", "docker", "fake");

const Integration = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  kind: IntegrationKind,
  // Set only on `kind: "cloud"` rows — see `domain/integrations/
  // integrations.ts`'s header comment on multi-slot cloud providers.
  provider: Schema.NullOr(IntegrationProvider),
  identifier: Schema.String,
  connectedAt: Schema.String,
  removedAt: Schema.NullOr(Schema.String),
  config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  // True only for the synthetic `idp` entry a deployment gets from
  // IDP_METADATA_URL/IDP_METADATA_XML (`config.ts`). There is no row behind
  // it — the provider lives in BetterAuth's options, not the database — so
  // the console uses this to render the card as configured rather than
  // editable, the same way `lockedRegion` makes the machine dialog show a
  // fixed value instead of a picker. Always false for real rows.
  managedByConfig: Schema.Boolean,
});

const ListIntegrationsResponse = Schema.Struct({ items: Schema.Array(Integration) });

// `orgId` is gone from the wire — derived from `CurrentUserTag.orgId`.
// `provider` is required when `kind === "cloud"` — enforced in the domain
// layer (`connectIntegration`), not expressed as a wire-schema refinement.
const ConnectIntegrationPayload = Schema.Struct({
  kind: IntegrationKind,
  provider: Schema.optional(IntegrationProvider),
  identifier: Schema.String.pipe(Schema.minLength(1)),
  config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const IntegrationIdPath = Schema.Struct({ id: Schema.String });

// `kind: "idp"` connects only, when the supplied SAML federation metadata
// URL turns out unreachable or not actually SAML metadata — see
// `services/IdpSsoService.ts`. Not reused from `access.ts`: no shared error
// schema module exists in this codebase (each route file declares its own).
export const BadRequestError = Schema.Struct({
  code: Schema.Literal("bad_request"),
  message: Schema.String,
});

export const IntegrationsGroup = HttpApiGroup.make("integrations")
  .add(HttpApiEndpoint.get("list", "/api/v1/integrations").addSuccess(ListIntegrationsResponse))
  .add(
    HttpApiEndpoint.post("connect", "/api/v1/integrations")
      .setPayload(ConnectIntegrationPayload)
      .addSuccess(Integration, { status: 201 })
      .addError(BadRequestError, { status: 400 }),
  )
  .add(
    HttpApiEndpoint.post("disconnect", "/api/v1/integrations/:id/disconnect")
      .setPath(IntegrationIdPath)
      .addSuccess(Schema.Struct({ ok: Schema.Literal(true) }))
      // Refusing to disconnect a config-managed identity provider is the only
      // way this fails today — see the handler.
      .addError(BadRequestError, { status: 400 }),
  )
  .middleware(CurrentUserAuthentication);
