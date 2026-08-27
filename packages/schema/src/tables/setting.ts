import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sourceEnum } from "../shared";

/**
 * A single setting value at a given scope (org / template / machine). Resolution across
 * the org → template → machine chain, with pinning, is done by `resolveSetting` — see
 * `resolve-setting.ts`. This table only stores the raw declared values.
 */
export const settingValues = pgTable(
  "setting_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: text("scope_type", { enum: ["org", "template", "machine"] }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    source: sourceEnum("source").notNull(),
    // When true, an org-level entry cannot be overridden by a template or machine below it.
    pinned: boolean("pinned").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("setting_values_scope_key_idx").on(table.scopeType, table.scopeId, table.key)],
);
