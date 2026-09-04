import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { OrgCatalogError } from "../../domain/organisation/catalog";
import { CurrentUserAuthentication } from "../middleware/auth";

// Org-curated region/image/size catalog for machine creation — see
// `domain/organisation/catalog.ts`. Only Azure has a real catalog today
// (Fake/Docker are regionless and freeform-image/size — see
// `PROVIDER_CAPABILITIES` on the console side), but the path is
// provider-generic so a future provider's catalog needs no route change.

const CatalogProvider = Schema.Literal("azure");
const CatalogKind = Schema.Literal("region", "image", "sku");

const CatalogItem = Schema.Struct({
  code: Schema.String,
  displayName: Schema.String,
  enabled: Schema.Boolean,
});

const CatalogPath = Schema.Struct({ provider: CatalogProvider, kind: CatalogKind });

const ListCatalogResponse = Schema.Struct({ items: Schema.Array(CatalogItem) });

const ToggleCatalogEntryPayload = Schema.Struct({
  code: Schema.String.pipe(Schema.minLength(1)),
  displayName: Schema.String.pipe(Schema.minLength(1)),
  enabled: Schema.Boolean,
});

const SyncRegionsResponse = Schema.Struct({ items: Schema.Array(CatalogItem) });
const SyncSizesResponse = Schema.Struct({ items: Schema.Array(CatalogItem) });

export const CatalogGroup = HttpApiGroup.make("catalog")
  .add(
    HttpApiEndpoint.get("list", "/api/v1/organisation/catalog/:provider/:kind")
      .setPath(CatalogPath)
      .addSuccess(ListCatalogResponse),
  )
  .add(
    HttpApiEndpoint.patch("toggle", "/api/v1/organisation/catalog/:provider/:kind")
      .setPath(CatalogPath)
      .setPayload(ToggleCatalogEntryPayload)
      .addSuccess(ListCatalogResponse)
      .addError(OrgCatalogError, { status: 422 }),
  )
  .add(
    HttpApiEndpoint.post(
      "syncRegions",
      "/api/v1/organisation/catalog/azure/regions/sync",
    ).addSuccess(SyncRegionsResponse),
  )
  .add(
    HttpApiEndpoint.post(
      "syncSizes",
      "/api/v1/organisation/catalog/azure/sizes/sync",
    ).addSuccess(SyncSizesResponse),
  )
  .middleware(CurrentUserAuthentication);
