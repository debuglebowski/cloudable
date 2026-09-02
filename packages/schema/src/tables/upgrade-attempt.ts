import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { machines } from "./machine";

/**
 * One row per upgrade attempt on a machine — success or failure — and the
 * due-date/backoff ledger for the transactional upgrade flow — upgrades
 * are transactional: snapshot → apply → verify → roll back on
 * verification failure.
 *
 * Every attempt, success or failure, pushes `nextEligibleAt` forward by a
 * full backoff interval — "a failed attempt resets the due-date clock
 * exactly as a success does, so a persistently failing machine backs off a
 * full interval instead of retrying every cycle." `consecutiveFailures`
 * feeds the exponential backoff (see `apps/control-plane/src/domain/upgrade/backoff.ts`)
 * and is reset to 0 on a success.
 *
 * Append-only by convention, like a log — new rows are inserted, never
 * updated. A machine's current eligibility is derived by reading its most
 * recent row (see `UpgradeService.isEligibleForUpgrade`), not by mutating a
 * single per-machine row in place. This table is deliberately separate from
 * the `events` table: it is internal scheduling state for the upgrade
 * mechanism, not part of the public compliance event catalogue.
 */
export const upgradeAttempts = pgTable("upgrade_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  machineId: uuid("machine_id")
    .notNull()
    .references(() => machines.id),
  previousImage: text("previous_image").notNull(),
  targetImage: text("target_image").notNull(),
  // "aborted" = the pre-upgrade snapshot itself could not be taken, so apply/
  // verify were never attempted and nothing on the machine changed.
  // "rollback_failed" = apply and/or verify failed AND the rollback restore
  // itself also failed — the worst case, needs manual attention.
  outcome: text("outcome", {
    enum: ["success", "rolled_back", "aborted", "rollback_failed"],
  }).notNull(),
  // The pre-upgrade snapshot taken for this attempt. Null only for
  // "aborted", where the snapshot step itself failed.
  preUpgradeSnapshotId: uuid("pre_upgrade_snapshot_id"),
  // Set only when outcome is "rolled_back" — the snapshot actually restored.
  restoredSnapshotId: uuid("restored_snapshot_id"),
  // Number of consecutive failed attempts ending at (and including, if this
  // one failed) this row — 0 for a success. Drives the exponential backoff.
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  backoffMs: integer("backoff_ms").notNull(),
  // Human-readable failure detail (reconcile mismatch, provisioning error, …).
  detail: text("detail"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  // Callers (e.g. a future scheduler) must check this via
  // `isEligibleForUpgrade` before calling `upgradeMachine` again.
  nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull(),
});
