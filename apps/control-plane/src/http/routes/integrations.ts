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

export const IntegrationsGroup = HttpApiGroup.make("integrations")
  .add(HttpApiEndpoint.get("list", "/api/v1/integrations").addSuccess(ListIntegrationsResponse))
  .add(
    HttpApiEndpoint.post("connect", "/api/v1/integrations")
      .setPayload(ConnectIntegrationPayload)
      .addSuccess(Integration, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.post("disconnect", "/api/v1/integrations/:id/disconnect")
      .setPath(IntegrationIdPath)
      .addSuccess(Schema.Struct({ ok: Schema.Literal(true) })),
  )
  .middleware(CurrentUserAuthentication);
