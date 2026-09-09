import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import { Effect } from "effect";
import {
  type IntegrationRow,
  connectIntegration,
  disconnectIntegration,
  listActiveIntegrations,
} from "../../domain/integrations/integrations";
import {
  type IdpSsoError,
  deleteSamlProvider,
  registerSamlProvider,
} from "../../services/IdpSsoService";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

const toWire = (row: IntegrationRow) => ({
  id: row.id,
  orgId: row.orgId,
  kind: row.kind,
  provider: row.provider,
  identifier: row.identifier,
  connectedAt: row.connectedAt.toISOString(),
  removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  config: row.config as Record<string, unknown>,
});

const idpSsoErrorMessage = (error: IdpSsoError): string => {
  switch (error.reason) {
    case "metadata_unreachable":
      return "Could not fetch that federation metadata URL — check it's reachable and correct.";
    case "metadata_invalid":
      return "That URL didn't return valid SAML metadata (no EntityDescriptor found).";
    case "register_failed":
      return error.cause instanceof Error
        ? `Entra rejected the SAML configuration: ${error.cause.message}`
        : "Entra rejected the SAML configuration.";
  }
};

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

        // Only `kind: "idp"` has a real system behind the row — see
        // `services/IdpSsoService.ts`. Everything else (cloud/secret_store)
        // is still the plain connection-pointer write it always was.
        if (payload.kind !== "idp") {
          return yield* connectIntegration({ ...payload, orgId: currentUser.orgId });
        }

        const metadataUrl = payload.config.metadataUrl;
        if (typeof metadataUrl !== "string" || metadataUrl.length === 0) {
          return yield* Effect.fail({
            code: "bad_request" as const,
            message: "config.metadataUrl is required to connect an identity provider.",
          });
        }

        // Captured before `connectIntegration` soft-deletes it (single-slot
        // per org — see that module's header comment) — its own SAML
        // provider row needs cleaning up too, once the new one is live.
        const previous = (yield* listActiveIntegrations(currentUser.orgId)).find(
          (row) => row.kind === "idp",
        );

        const inserted = yield* connectIntegration({ ...payload, orgId: currentUser.orgId });

        const request = yield* HttpServerRequest.HttpServerRequest;
        const registered = yield* registerSamlProvider({
          providerId: inserted.id,
          metadataUrl,
          headers: new Headers(request.headers),
        }).pipe(Effect.either);

        if (registered._tag === "Left") {
          // Roll back the Cloudable-side row too — a "connected" integration
          // that can't actually authenticate anyone is worse than none.
          yield* disconnectIntegration(inserted.id, currentUser.orgId);
          return yield* Effect.fail({
            code: "bad_request" as const,
            message: idpSsoErrorMessage(registered.left),
          });
        }

        if (previous) {
          yield* deleteSamlProvider(previous.id);
        }

        return inserted;
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("disconnect", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* disconnectIntegration(path.id, currentUser.orgId);
        // Harmless no-op for a cloud/secret_store id — matches zero rows.
        yield* deleteSamlProvider(path.id);
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    ),
);
