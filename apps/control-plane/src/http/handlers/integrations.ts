import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  type IntegrationRow,
  connectIntegration,
  disconnectIntegration,
  listActiveIntegrations,
} from "../../domain/integrations/integrations";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

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
    .handle("list", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* listActiveIntegrations(currentUser.orgId);
      }).pipe(
        Effect.map((rows) => ({ items: rows.map(toWire) })),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* connectIntegration({ ...payload, orgId: currentUser.orgId });
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("disconnect", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* disconnectIntegration(path.id, currentUser.orgId);
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    ),
);
