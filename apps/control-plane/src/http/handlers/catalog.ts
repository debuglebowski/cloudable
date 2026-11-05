import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { requireAdminUser } from "../../domain/authz";
import {
  type CatalogEntry,
  listProviderCatalog,
  syncAzureRegions,
  syncAzureSizes,
} from "../../services/CloudCatalogService";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

const toWireItem = (entry: CatalogEntry) => ({
  code: entry.code,
  displayName: entry.displayName,
  vcpus: entry.vcpus ?? null,
  memoryGb: entry.memoryGb ?? null,
  architecture: entry.architecture ?? null,
});

export const CatalogLive = HttpApiBuilder.group(Api, "catalog", (handlers) =>
  handlers
    .handle("list", ({ path }) =>
      Effect.gen(function* () {
        const items = yield* listProviderCatalog(path.provider, path.kind);
        return { items: items.map(toWireItem) };
      }).pipe(Effect.catchTag("CloudCatalogError", (e) => Effect.die(e))),
    )
    .handle("syncRegions", () =>
      Effect.gen(function* () {
        yield* requireAdminUser(yield* CurrentUserTag, "Only an admin can sync the cloud catalog.");
        const items = yield* syncAzureRegions();
        return { items: items.map(toWireItem) };
      }).pipe(Effect.catchTag("CloudCatalogError", (e) => Effect.die(e))),
    )
    .handle("syncSizes", () =>
      Effect.gen(function* () {
        yield* requireAdminUser(yield* CurrentUserTag, "Only an admin can sync the cloud catalog.");
        const items = yield* syncAzureSizes();
        return { items: items.map(toWireItem) };
      }).pipe(Effect.catchTag("CloudCatalogError", (e) => Effect.die(e))),
    ),
);
