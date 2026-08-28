import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sourceEnum } from "../shared";

/**
 * A single package manifest entry at a given scope (org / template / machine)
 * — spec.md §6. An entry names a package and optionally pins a version
 * (`docker`, `nodejs 20`); there is no dependency resolution here, that's the
 * machine's own package manager's job.
 *
 * Rows are scoped exactly like `settingValues` (see `setting.ts`), one row
 * per (scopeType, scopeId, packageName) — resolution across the org →
 * template → machine chain, lowest level wins, is done by `resolveSetting()`
 * (see `apps/control-plane/src/domain/machine/manifest.ts`, which treats
 * each distinct `packageName` as a `resolveSetting` key rather than
 * reimplementing the chain walk).
 *
 * Kept as its own table rather than folded into `settingValues`: a package
 * manifest is a *set* of named entries (each independently addable/removable
 * by name), not a single keyed value, and it is a hot path for the
 * allowlist-detection compliance check (unit 8) and the reconcile loop
 * (unit 1) — both want a table shaped exactly like the domain concept they
 * consume, not a generic bag filtered by a key-string convention.
 */
export const machinePackages = pgTable(
  "machine_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: text("scope_type", { enum: ["org", "template", "machine"] }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    packageName: text("package_name").notNull(),
    // Optional version pin, e.g. "20" for a `nodejs 20` entry. Null means
    // "any version" — no dependency resolution is performed either way.
    versionPin: text("version_pin"),
    source: sourceEnum("source").notNull(),
    // When true, this entry cannot be overridden by a row at a lower scope
    // (org pins template/machine, template pins machine). Overriding one is
    // a validation error at edit time — see `domain/machine/manifest.ts`'s
    // `findPinConflicts` — never a silent no-op at reconcile.
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One entry per package name per scope — edits upsert against this key.
    uniqueIndex("machine_packages_scope_package_idx").on(
      table.scopeType,
      table.scopeId,
      table.packageName,
    ),
  ],
);
