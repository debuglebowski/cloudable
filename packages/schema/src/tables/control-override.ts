import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Per-org override of a control's status in the compliance control map —
 * organisation-level configuration, overridable per control. Cloudable
 * ships defaults for the controls it is itself audited against; customers
 * adjust for their own framework or auditor.
 *
 * `computeControlMap` (apps/control-plane/src/compliance/control-map.ts)
 * remains the source of the *default* status for every control Cloudable
 * knows about, purely derived from what's registered in
 * `COMPLIANCE_CHECKS` — this table only layers an explicit choice on top.
 * A row here exists only for a control an org has deliberately overridden;
 * its absence means "use the computed default", never "not_covered" or any
 * other implicit value. See `applyControlOverrides` in `control-map.ts`
 * for how the two are combined.
 */
export const controlOverrides = pgTable(
  "control_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    // Matches `ControlDefinition.id` in control-map.ts (e.g.
    // "access-management") — not a foreign key, since the control taxonomy
    // itself lives in code, not in a table.
    controlId: text("control_id").notNull(),
    status: text("status", {
      enum: ["implemented", "manual_action_required", "not_covered"],
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One override per (org, control) — setting a new override for a
    // control an org already overrode replaces it via upsert rather than
    // accumulating history; this is live policy, not an event log.
    uniqueIndex("control_overrides_org_control_idx").on(table.orgId, table.controlId),
  ],
);
