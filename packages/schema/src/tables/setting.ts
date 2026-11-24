import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sourceEnum } from "../shared";

/**
 * A single setting value at a given scope (org / profile / machine). Resolution across
 * the org → profile → machine chain, with locking, is done by `resolveSetting` — see
 * `resolve-setting.ts`. This table only stores the raw declared values.
 */
export const settingValues = pgTable(
  "setting_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: text("scope_type", { enum: ["org", "profile", "machine"] }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    source: sourceEnum("source").notNull(),
    // When true, a scope below this one cannot override this entry (an org lock
    // binds profiles and machines, a profile lock binds its machines).
    locked: boolean("locked").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("setting_values_scope_key_idx").on(table.scopeType, table.scopeId, table.key)],
);
