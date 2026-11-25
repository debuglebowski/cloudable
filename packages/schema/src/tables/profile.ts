import {
  type AnyPgColumn,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
 * profile leaves blank. Each has a lock flag:
 * - unlocked: a starting value. The create form fills it in, and the machine may
 *   differ. The admin may change it at any time. Existing machines never change.
 * - locked: every machine on the profile must have this value. It cannot change
 *   while a machine that is not archived uses the profile.
 * A lock needs a value.
 *
 * A profile may extend one base profile (`baseProfileId`), in the same org. The
 * chain is then org → base profile → profile → machine. One level only: a base
 * has no base of its own, and a profile that is a base cannot get one.
 *
 * See `docs/inheritance.md`.
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
    /** The profile this one extends, or null. Same org, one level only (checked in code). */
    baseProfileId: uuid("base_profile_id").references((): AnyPgColumn => profiles.id),
    provider: text("provider", { enum: ["azure", "docker", "fake"] }),
    region: text("region"),
    sizeSku: text("size_sku"),
    image: text("image"),
    providerLocked: boolean("provider_locked").notNull().default(false),
    regionLocked: boolean("region_locked").notNull().default(false),
    sizeLocked: boolean("size_locked").notNull().default(false),
    imageLocked: boolean("image_locked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("profiles_org_name_idx").on(table.orgId, table.name)],
);
