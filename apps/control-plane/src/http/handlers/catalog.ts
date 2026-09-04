import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  type OrgCatalogError,
  listOrgCatalog,
  toggleOrgCatalogEntry,
} from "../../domain/organisation/catalog";
import { syncAzureRegions } from "../../services/CloudCatalogService";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

/** `unknown_catalog_entry` is the one client-facing validation reason
 * (same convention as `http/handlers/organisation.ts`'s
 * `VALIDATION_REASONS`); every other reason is our own infra breaking. */
const rethrowInfraAsDefect = (e: OrgCatalogError) =>
  e.reason === "unknown_catalog_entry" ? Effect.fail(e) : Effect.die(e);

export const CatalogLive = HttpApiBuilder.group(Api, "catalog", (handlers) =>
  handlers
    .handle("list", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const items = yield* listOrgCatalog(currentUser.orgId, path.provider, path.kind);
        return { items };
      }).pipe(Effect.catchTag("OrgCatalogError", (e) => Effect.die(e))),
    )
    .handle("toggle", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* toggleOrgCatalogEntry({
          orgId: currentUser.orgId,
          provider: path.provider,
          kind: path.kind,
          code: payload.code,
          displayName: payload.displayName,
          enabled: payload.enabled,
          actorType: "person",
          actorId: currentUser.personId,
        });
        const items = yield* listOrgCatalog(currentUser.orgId, path.provider, path.kind);
        return { items };
      }).pipe(Effect.catchTag("OrgCatalogError", rethrowInfraAsDefect)),
    )
    .handle("syncRegions", () =>
      Effect.gen(function* () {
        const entries = yield* syncAzureRegions();
        return { items: entries.map((entry) => ({ ...entry, enabled: false })) };
      }).pipe(Effect.catchTag("CloudCatalogError", (e) => Effect.die(e))),
    ),
);
