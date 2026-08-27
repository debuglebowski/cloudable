import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A connected external system: identity provider, cloud, or secret store. Federation only — no credentials stored here. */
export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  kind: text("kind", { enum: ["idp", "cloud", "secret_store"] }).notNull(),
  identifier: text("identifier").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
});
