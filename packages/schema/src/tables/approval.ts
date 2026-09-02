import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A request for approval to perform a sensitive action (restore, break-glass, admin access, offboarding). */
export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  actionType: text("action_type", {
    enum: ["snapshot_restore", "break_glass", "admin_access", "offboarding"],
  }).notNull(),
  mode: text("mode", { enum: ["none", "single", "dual"] }).notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
    .notNull()
    .default("pending"),
  requestedByPersonId: uuid("requested_by_person_id").notNull(),
  targetMachineId: uuid("target_machine_id"),
  // Nullable, like `targetMachineId` — a person-targeted action type (today: only
  // `offboarding`) sets this instead. An approval has at most one real target; both
  // columns existing lets the generic approval object point at either
  // kind without a separate table per target type. Also lets an approver (and the
  // resumed-after-approval path) know WHO an offboarding approval is about, not
  // just that "an offboarding" is pending.
  targetPersonId: uuid("target_person_id"),
  reason: text("reason").notNull(),
  requiredApprovals: integer("required_approvals").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

/** A single person's decision against an approval request. Dual mode needs two of these. */
export const approvalDecisions = pgTable("approval_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  approvalId: uuid("approval_id")
    .notNull()
    .references(() => approvals.id),
  personId: uuid("person_id").notNull(),
  decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
});
