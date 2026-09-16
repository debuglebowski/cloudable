import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orgs } from "./org";
import { people } from "./person";

/** A persistent, governed cloud machine. Exactly one owner, always a person, or none during offboarding. */
export const machines = pgTable("machines", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  // No `templates` table exists yet (v1 has no templates — see CLAUDE.md "Not in v1").
  // Kept as a bare nullable uuid, deliberately without a foreign key, so it can be
  // wired up to a future `templates` table without a data migration.
  templateId: uuid("template_id"),
  // Nullable because the owner is cleared (not the row deleted) during offboarding —
  // a machine's history must survive its owner leaving.
  ownerPersonId: uuid("owner_person_id").references(() => people.id),
  name: text("name").notNull(),
  // Which ProvisioningService backend this machine was created on — a
  // physical fact fixed at creation, same as region/image below, never
  // edited afterward (a machine's underlying provisioning backend isn't
  // something you switch a live machine between).
  provider: text("provider", { enum: ["azure", "docker", "fake"] }).notNull(),
  // Nullable: only azure-provisioned machines have a region — see
  // packages/contracts/src/domains/providers.ts's PROVIDER_CAPABILITIES.
  region: text("region"),
  sizeSku: text("size_sku").notNull(),
  image: text("image").notNull(),
  state: text("state", {
    enum: [
      "provisioning",
      "running",
      "stopped",
      "archived_restorable",
      "archived_expired",
      "error",
    ],
  })
    .notNull()
    .default("provisioning"),
  // The most recent provisioning/reconcile failure message, if any — the
  // detail behind a "error" `state` that the console surfaces directly
  // rather than making a user dig through the event log for it. Cleared
  // (set back to null) whenever a provisioning attempt succeeds.
  lastError: text("last_error"),
  // The cloud provider's resource id for this machine, once provisioned.
  externalResourceId: text("external_resource_id"),
  // Last time the control agent successfully checked in — feeds the
  // "machines are reporting" compliance check.
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  // The last `MachineReportedState` (see apps/control-plane/src/domain/machine/types.ts)
  // received from this machine's agent, as raw JSON. Feature unit 6's
  // event-derivation engine (services/reconcile-diff.ts) is the only writer:
  // it diffs each new report against this column via `deriveEvents`, then
  // overwrites it with the new report. Reused rather than a dedicated
  // `machineLastKnownState` table — it's a 1:1 relationship with `machines`,
  // and null (no report yet) is exactly the "never reported" case
  // `deriveEvents` treats as `previous: undefined`.
  lastReportedState: jsonb("last_reported_state"),
  /**
   * The machine's own measurement of its filesystems, from its last report:
   * `{ persistent: {usedBytes,totalBytes}, root: {usedBytes,totalBytes}, at: ISO }`.
   *
   * Here rather than derived from the cloud because no provider reports it. A snapshot
   * resource carries the PROVISIONED size of its source disk and nothing else, which is
   * why every snapshot in the fleet recorded an identical 64 GiB whatever was on it.
   * Only the machine can see its own filesystems.
   *
   * One jsonb rather than a column per number: it is a single observation written and
   * read as a unit, and it grows by a field rather than a migration. `at` is kept so a
   * stale measurement is recognisable — a snapshot sized from a week-old reading should
   * not look like a fresh one.
   */
  volumeUsage: jsonb("volume_usage"),
  /**
   * The package names the agent reported at its most recent check-in, as a
   * JSON array of strings. Overwritten each report — this is current state,
   * not history; history is the event log.
   *
   * A jsonb array rather than a row-per-package table: a real Ubuntu server
   * image carries several hundred packages, so a table would churn ~800 rows
   * per machine every 30 seconds to answer a question ("is X installed") that
   * one array answers in a single read. The cost is losing per-package
   * first-seen timestamps, which nothing needs yet.
   */
  installedPackages: jsonb("installed_packages"),
  /**
   * What `installedPackages` held at this machine's FIRST report — i.e. what
   * the image shipped with, before anyone touched it.
   *
   * Load-bearing for the packages table and for the "no undeclared software"
   * compliance check: without it, every one of the image's own several hundred
   * packages reads as undeclared software installed by nobody. Captured once
   * and never rewritten, so a package removed from the image later still reads
   * as part of the baseline, which is what it was.
   */
  baselinePackages: jsonb("baseline_packages"),
  baselineCapturedAt: timestamp("baseline_captured_at", { withTimezone: true }),
  /**
   * Installed version per package, for declared packages only — the set a
   * version pin could apply to. Used to flag a package sitting at a version
   * other than the one it was pinned to.
   *
   * Not the whole inventory: versions for all several hundred packages would
   * be tens of KB rewritten every 30 seconds to answer a question about a
   * handful of them.
   */
  declaredPackageVersions: jsonb("declared_package_versions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  legalHold: boolean("legal_hold").notNull().default(false),
  /**
   * The version/ETag the agent's poll endpoint serves, so a poll with nothing
   * new costs a 304 instead of a body.
   *
   * Bumped when a package action is enqueued. Previously bumped by a
   * confirmation-gated reconcile trigger that no reader ever consulted — the
   * poll served a hardcoded constant — so this column claimed to be an ETag
   * for a long time before it was one.
   */
  desiredStateVersion: integer("desired_state_version").notNull().default(0),
});
