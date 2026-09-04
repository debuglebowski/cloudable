import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A connected external system: identity provider, cloud, or secret store. Federation only — no credentials stored here. */
export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  kind: text("kind", { enum: ["idp", "cloud", "secret_store"] }).notNull(),
  // Which cloud provider this row is for — set only on `kind: "cloud"` rows
  // (null for idp/secret_store). This is what lets three "cloud" rows
  // coexist per org (one each for azure/docker/fake) instead of the single
  // slot-per-kind that idp/secret_store still have — see
  // `domain/integrations/integrations.ts`'s replace-by-(kind, provider) note.
  provider: text("provider", { enum: ["azure", "docker", "fake"] }),
  identifier: text("identifier").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
});
