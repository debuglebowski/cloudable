import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { approvals } from "./approval";

/**
 * The parameters of a snapshot restore that went "pending" (single/dual
 * approval mode) — persisted so `resumeRestore` can pick up exactly where
 * `restoreSnapshot` left off once the approval is later decided. Unlike
 * offboarding, a restore's approval alone can't identify what to
 * do: `approvals.targetMachineId` and `.reason` survive, but `snapshotId`,
 * `mode`, and `confirmSecretBindings` (safety-critical — never inferred,
 * see `restore.ts`'s own doc comment) have no home on the generic approval
 * row. Keyed 1:1 by `approvalId` rather than its own surrogate id — there is
 * never more than one restore request per approval.
 */
export const restoreRequests = pgTable("restore_requests", {
  approvalId: uuid("approval_id")
    .primaryKey()
    .references(() => approvals.id),
  snapshotId: uuid("snapshot_id").notNull(),
  targetMachineId: uuid("target_machine_id").notNull(),
  mode: text("mode", { enum: ["data", "config", "full"] }).notNull(),
  // Persists the SAME explicit confirmation the original caller gave at request
  // time — never fabricated or defaulted here (see restore.ts). Replaying it
  // unchanged on resume is not the same thing as inferring it.
  confirmSecretBindings: boolean("confirm_secret_bindings").notNull().default(false),
  requestedByPersonId: uuid("requested_by_person_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set once `resumeRestore` has actually written `snapshot.restored` for this
  // request — the idempotency guard: a repeat `sync` call after a successful
  // resume must not publish a second `snapshot.restored` event.
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
