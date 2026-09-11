import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import { Effect } from "effect";
import { CONFIGURED_IDP_PROVIDER_ID, config } from "../../config";
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

/** Fixed at module load so the synthesised card reports a stable date rather than a new one on every request. */
const BOOT_TIME = new Date();

const toWire = (row: IntegrationRow) => ({
  id: row.id,
  orgId: row.orgId,
  kind: row.kind,
  provider: row.provider,
  identifier: row.identifier,
  connectedAt: row.connectedAt.toISOString(),
  removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  config: row.config as Record<string, unknown>,
  managedByConfig: false,
});

/**
 * The `idp` card a deployment gets from config, as a wire object. There is no
 * database row to return — `defaultSSO` lives in BetterAuth's options — so
 * one is synthesised, with an id that matches the provider id the SAML
 * endpoints actually use.
 *
 * `orgId` is the caller's own: this is a deployment-wide provider, and a
 * self-hosted deployment is realistically single-org (the same assumption
 * `findAnyActiveIdpIntegration` already documents), so attributing it to
 * whoever is asking is both accurate enough and keeps the wire shape honest.
 */
const configuredIdpWire = (orgId: string) => ({
  id: CONFIGURED_IDP_PROVIDER_ID,
  orgId,
  kind: "idp" as const,
  provider: null,
  identifier: config.idpDisplayName,
  // No connection event ever happened, so there is no timestamp to report.
  // The deployment's own start is the closest true answer, and inventing
  // `now` on every request would make the card flicker a changing date.
  connectedAt: BOOT_TIME.toISOString(),
  removedAt: null,
  config: { provider: "entra_id", metadataUrl: config.idpMetadataUrl } as Record<string, unknown>,
  managedByConfig: true,
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
        const rows = yield* listActiveIntegrations(currentUser.orgId);
        // Deployment config replaces any idp row rather than sitting
        // alongside it. A stored row can only exist here if one was connected
        // before IDP_METADATA_URL was set; showing both would offer a
        // Disconnect that changes nothing, since sign-in resolves the
        // config-declared provider regardless (`defaultSSO` is checked before
        // the database).
        const items = config.idpSamlConfig
          ? [
              ...rows.filter((row) => row.kind !== "idp").map(toWire),
              configuredIdpWire(currentUser.orgId),
            ]
          : rows.map(toWire);
        return { items };
      }).pipe(Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e))),
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;

        // Deployment config wins. `@better-auth/sso` would reject the
        // registration anyway (it reserves any providerId declared in
        // `defaultSSO`), but that failure surfaces as an opaque rollback —
        // this says what is actually going on, and to whom.
        if (payload.kind === "idp" && config.idpSamlConfig !== null) {
          return yield* Effect.fail({
            code: "bad_request" as const,
            message:
              "The identity provider is set by deployment configuration (IDP_METADATA_URL) and cannot be changed here. Update it in Terraform and redeploy.",
          });
        }

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
        // The config-declared provider has no row to soft-delete and no
        // auth_sso_provider row to remove, so a disconnect would silently do
        // nothing while the console showed a success toast. The UI hides the
        // button, but the endpoint is reachable regardless.
        if (path.id === CONFIGURED_IDP_PROVIDER_ID && config.idpSamlConfig !== null) {
          return yield* Effect.fail({
            code: "bad_request" as const,
            message:
              "The identity provider is set by deployment configuration (IDP_METADATA_URL) and cannot be disconnected here. Remove it in Terraform and redeploy.",
          });
        }
        yield* disconnectIntegration(path.id, currentUser.orgId);
        // Harmless no-op for a cloud/secret_store id — matches zero rows.
        yield* deleteSamlProvider(path.id);
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
      ),
    ),
);
