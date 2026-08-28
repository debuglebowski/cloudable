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
  region: text("region").notNull(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  legalHold: boolean("legal_hold").notNull().default(false),
  // Bumped only by the confirmation-gated reconcile-trigger endpoint
  // (config feature unit — see apps/control-plane/src/domain/config).
  // Editing desired state (settingValues) never touches this column; it is
  // the version/ETag the agent's poll endpoint compares against to decide
  // there is new desired state to pull (docs/spec.md §16, §23).
  desiredStateVersion: integer("desired_state_version").notNull().default(0),
});
