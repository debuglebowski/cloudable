import { integer, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Global reference data: what does a provider actually offer — "what does
 * Azure actually offer," not what any one org has chosen to allow. Not
 * org-scoped (there's exactly one Azure subscription per self-hosted
 * deployment, per `config.ts`'s `azureSubscriptionId` — no per-org variance
 * to model). Regions and sizes are synced from the real Azure SDK
 * (`services/CloudCatalogService.ts`'s `syncAzureRegions`/`syncAzureSizes`);
 * images are seeded from `ProvisioningService.azure.ts`'s own `UBUNTU_IMAGES`
 * map, since Azure has no API enumerating "images compatible with our
 * cloud-init setup" the way it does for regions/sizes.
 */
export const providerCatalogEntries = pgTable(
  "provider_catalog_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider", { enum: ["azure", "docker", "fake"] }).notNull(),
    kind: text("kind", { enum: ["region", "image", "sku"] }).notNull(),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    // Only meaningful for kind === "sku" — null for regions/images, which have
    // no such concept. Structured (not just baked into displayName) so the
    // console can filter the size list by objective facts instead of forcing
    // an admin to scroll or guess exact SKU names across ~1,200 entries.
    // vCPUs is always a whole number in real Azure data (confirmed against a
    // real subscription); memoryGb is not -- Standard_B1ls reports "0.5",
    // several M-series report values like "218.75" -- so it's `real`, not
    // `integer` (an earlier version of this column used integer and broke
    // the sync outright the first time it hit one of these SKUs, rolling
    // back the whole upsert transaction with no visible error).
    vcpus: integer("vcpus"),
    memoryGb: real("memory_gb"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_catalog_entries_provider_kind_code_idx").on(
      table.provider,
      table.kind,
      table.code,
    ),
  ],
);

/**
 * An org's curated allow-list over `providerCatalogEntries` — presence of a
 * row means "enabled," same "set of independently addable/removable named
 * entries" shape as `machinePackages` (see that table's own header comment
 * for why this isn't folded into the generic `settingValues` bag). Only
 * meaningful for providers whose `PROVIDER_CAPABILITIES` claims a catalog
 * (`packages/contracts/src/domains/providers.ts`) — today, Azure only.
 */
export const orgCatalogSelections = pgTable(
  "org_catalog_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    provider: text("provider", { enum: ["azure", "docker", "fake"] }).notNull(),
    kind: text("kind", { enum: ["region", "image", "sku"] }).notNull(),
    code: text("code").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_catalog_selections_org_provider_kind_code_idx").on(
      table.orgId,
      table.provider,
      table.kind,
      table.code,
    ),
  ],
);
