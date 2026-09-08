import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { AzureNotConfiguredError } from "../../services/CloudCatalogService";
import { CurrentUserAuthentication } from "../middleware/auth";

// The real, fully-synced region/image/size catalog for machine creation —
// see `services/CloudCatalogService.ts` and `packages/schema/src/tables/
// provider-catalog.ts`'s doc comment. No per-org curation (retired — see
// that doc comment for why): the Add Machine form reads this directly and
// computes compatibility itself from vcpus/memoryGb/architecture, rather
// than trusting an admin-maintained allow-list that could drift out of sync
// with what's actually valid. Only Azure has a real catalog today
// (Fake/Docker are regionless and freeform-image/size), but the path stays
// provider-generic so a future provider's catalog needs no route change.

const CatalogProvider = Schema.Literal("azure");
const CatalogKind = Schema.Literal("region", "image", "sku");

const CatalogItem = Schema.Struct({
  code: Schema.String,
  displayName: Schema.String,
  /** Only meaningful for kind "sku" — null for regions/images. */
  vcpus: Schema.NullOr(Schema.Number),
  memoryGb: Schema.NullOr(Schema.Number),
  /** Meaningful for kind "sku" (what it runs on) and "image" (what it
   * requires) — null for regions. See `provider-catalog.ts`'s doc comment. */
  architecture: Schema.NullOr(Schema.String),
});

const CatalogPath = Schema.Struct({ provider: CatalogProvider, kind: CatalogKind });

const ListCatalogResponse = Schema.Struct({ items: Schema.Array(CatalogItem) });

const SyncRegionsResponse = Schema.Struct({ items: Schema.Array(CatalogItem) });
const SyncSizesResponse = Schema.Struct({ items: Schema.Array(CatalogItem) });

export const CatalogGroup = HttpApiGroup.make("catalog")
  .add(
    HttpApiEndpoint.get("list", "/api/v1/organisation/catalog/:provider/:kind")
      .setPath(CatalogPath)
      .addSuccess(ListCatalogResponse),
  )
  .add(
    HttpApiEndpoint.post("syncRegions", "/api/v1/organisation/catalog/azure/regions/sync")
      .addSuccess(SyncRegionsResponse)
      .addError(AzureNotConfiguredError, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.post("syncSizes", "/api/v1/organisation/catalog/azure/sizes/sync")
      .addSuccess(SyncSizesResponse)
      .addError(AzureNotConfiguredError, { status: 409 }),
  )
  .middleware(CurrentUserAuthentication);
