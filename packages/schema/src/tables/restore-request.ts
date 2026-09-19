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
  // Which kind of target the request named. Restoring into a NEW machine and restoring
  // ONTO an existing one are different operations with different blast radii, and the
  // resumed restore has to know which was approved — not re-decide it from whichever
  // columns happen to be populated.
  targetKind: text("target_kind", { enum: ["new_machine", "existing_machine"] })
    .notNull()
    .default("existing_machine"),
  // Nullable since `target_kind: "new_machine"`: the machine does not exist yet and must
  // not be created for a restore nobody has approved. Filled in by `resumeRestore` once
  // the machine is real, so the row still records what the restore actually landed on.
  targetMachineId: uuid("target_machine_id"),
  // Only for `target_kind: "new_machine"`. The owner is never inferred from the snapshot's
  // original machine — a common restore is recovering an offboarded person's data, and
  // that owner is exactly the one who should not get the new machine (invariant 3: exactly
  // one owner, always a person).
  ownerPersonId: uuid("owner_person_id"),
  newMachineName: text("new_machine_name"),
  // The same explicit acknowledgement as `confirm_secret_bindings`, for the other
  // destructive thing a restore can do: overwriting a machine that still has a data disk.
  // Required at request time for a non-archived target, replayed unchanged on resume.
  confirmDestroysData: boolean("confirm_destroys_data").notNull().default(false),
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
