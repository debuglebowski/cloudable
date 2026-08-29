import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  connectIntegration,
  disconnectIntegration,
  type IntegrationRow,
  listActiveIntegrations,
} from "../../domain/integrations/integrations";
import { Api } from "../api";

const toWire = (row: IntegrationRow) => ({
  id: row.id,
  orgId: row.orgId,
  kind: row.kind,
  identifier: row.identifier,
  connectedAt: row.connectedAt.toISOString(),
  removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  config: row.config as Record<string, unknown>,
});

export const IntegrationsLive = HttpApiBuilder.group(Api, "integrations", (handlers) =>
  handlers
    .handle("list", ({ urlParams }) =>
      listActiveIntegrations(urlParams.orgId).pipe(
        Effect.map((rows) => ({ items: rows.map(toWire) })),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("connect", ({ payload }) =>
      connectIntegration(payload).pipe(
        Effect.map(toWire),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("disconnect", ({ path }) =>
      disconnectIntegration(path.id).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    ),
);
