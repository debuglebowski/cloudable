import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

const IntegrationKind = Schema.Literal("idp", "cloud", "secret_store");

const Integration = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  kind: IntegrationKind,
  identifier: Schema.String,
  connectedAt: Schema.String,
  removedAt: Schema.NullOr(Schema.String),
  config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const ListIntegrationsUrlParams = Schema.Struct({ orgId: Schema.String });
const ListIntegrationsResponse = Schema.Struct({ items: Schema.Array(Integration) });

const ConnectIntegrationPayload = Schema.Struct({
  orgId: Schema.String,
  kind: IntegrationKind,
  identifier: Schema.String.pipe(Schema.minLength(1)),
  config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const IntegrationIdPath = Schema.Struct({ id: Schema.String });

export const IntegrationsGroup = HttpApiGroup.make("integrations")
  .add(
    HttpApiEndpoint.get("list", "/api/v1/integrations")
      .setUrlParams(ListIntegrationsUrlParams)
      .addSuccess(ListIntegrationsResponse),
  )
  .add(
    HttpApiEndpoint.post("connect", "/api/v1/integrations")
      .setPayload(ConnectIntegrationPayload)
      .addSuccess(Integration, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.post("disconnect", "/api/v1/integrations/:id/disconnect")
      .setPath(IntegrationIdPath)
      .addSuccess(Schema.Struct({ ok: Schema.Literal(true) })),
  );
