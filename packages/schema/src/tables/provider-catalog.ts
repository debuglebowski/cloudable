import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Global reference data: what does a provider actually offer — "what does
 * Azure actually offer," not what any one org has chosen to allow. Not
 * org-scoped (there's exactly one Azure subscription per self-hosted
 * deployment, per `config.ts`'s `azureSubscriptionId` — no per-org variance
 * to model). Regions are synced from the real Azure SDK
 * (`services/CloudCatalogService.ts`'s `syncRegions`); images are seeded
 * from `ProvisioningService.azure.ts`'s own `UBUNTU_IMAGES` map, since Azure
 * has no API enumerating "images compatible with our cloud-init setup" the
 * way it does for regions.
 */
export const providerCatalogEntries = pgTable(
  "provider_catalog_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider", { enum: ["azure", "docker", "fake"] }).notNull(),
    kind: text("kind", { enum: ["region", "image"] }).notNull(),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
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
    kind: text("kind", { enum: ["region", "image"] }).notNull(),
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
