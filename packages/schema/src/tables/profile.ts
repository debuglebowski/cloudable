import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs } from "./org";

/**
 * A profile: a named set of settings that machines link to. The chain is
 * org → profile → machine, lowest level wins (`resolveSetting`). A profile's
 * own settings and packages live in `setting_values` / `machine_packages` with
 * `scopeType: "profile"`. Nothing is copied onto a machine; editing a profile
 * changes every machine on it that has not overridden the setting.
 *
 * The four creation fields (provider, region, size, image) are used only when a
 * machine is created. All are optional: the create form asks for whatever the
 * profile leaves blank. They cannot be edited while a machine that is not
 * archived uses the profile. See `docs/inheritance.md`.
 *
 * Profiles are archived, never deleted. Events and machines point at them.
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    description: text("description"),
    provider: text("provider", { enum: ["azure", "docker", "fake"] }),
    region: text("region"),
    sizeSku: text("size_sku"),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("profiles_org_name_idx").on(table.orgId, table.name)],
);
