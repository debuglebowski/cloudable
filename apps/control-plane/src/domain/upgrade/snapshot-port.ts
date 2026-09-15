import { snapshots } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

/**
 * ============================================================================
 * PARTIALLY CONSOLIDATED with unit 15's real `domain/archive/*`.
 * ============================================================================
 * `createSnapshot` has been removed from this file — `UpgradeService.ts` now
 * calls unit 15's real `createSnapshot` (`../archive/snapshot.ts`) directly,
 * which is signature-compatible for the `(machineId, trigger)` positional
 * call this unit needs, and is strictly more correct (real org→machine
 * retention resolution, legal-hold inheritance, region/correlationId).
 *
 * `restoreSnapshot` below is INTENTIONALLY still this unit's own stub, not
 * unit 15's real one: unit 15's real `restoreSnapshot` is person-initiated
 * (`requestedByPersonId`) and gated through `ApprovalService`, modeling a
 * human asking for old data back. This unit's rollback is the opposite
 * shape — the control plane restoring a snapshot IT JUST TOOK, moments
 * earlier, as the automatic failure path of the SAME upgrade transaction,
 * with no human in the loop and no approval to gate on. Reconciling these
 * two into one function is a real design decision (does "restore" need a
 * "system-initiated, no-approval" mode? a separate rollback primitive
 * entirely?) — not resolved here, left as a flagged follow-up rather than
 * forcing an awkward fit that would either wrongly require approval for an
 * automatic rollback or wrongly skip approval for a human-requested one.
 * ============================================================================
 */

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  reason: "machine_not_found" | "snapshot_not_found" | "db_error" | "not_implemented";
  cause?: unknown;
}> {}

export type RestoreMode = "data" | "config" | "full";

export interface RestoreSnapshotOptions {
  targetMachineId: string;
  /**
   * Restore modes are escalating-approval, gated by the approval object
   * for HUMAN-initiated restores. `null` here means a
   * system-initiated rollback: the control plane restoring a snapshot it
   * itself took moments earlier, as the automatic failure path of the SAME
   * upgrade transaction — not a person requesting old data back. Flagged
   * for unit 5 (approvals) / unit 15 (restore) to weigh in on whether this
   * distinction should be formalized (e.g. a dedicated "system" approval
   * mode) once their real implementations land.
   */
  approvalId: string | null;
  reason: string;
}

export interface RestoreSnapshotResult {
  snapshotId: string;
  targetMachineId: string;
  mode: RestoreMode;
  restoredAt: Date;
}

export const restoreSnapshot = (
  snapshotId: string,
  mode: RestoreMode,
  options: RestoreSnapshotOptions,
): Effect.Effect<RestoreSnapshotResult, SnapshotError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const snapshotRows = yield* Effect.tryPromise({
      try: () => db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).limit(1),
      catch: (cause) => new SnapshotError({ reason: "db_error", cause }),
    });
    if (!snapshotRows[0]) {
      return yield* Effect.fail(
        new SnapshotError({ reason: "snapshot_not_found", cause: snapshotId }),
      );
    }

    // Nothing here reattaches anything. A real restore would hand the snapshotted
    // volume back to `options.targetMachineId` via `ProvisioningService` and emit
    // `snapshot.restored`; no `ProvisioningService` in this build has a restore
    // operation at all, and unit 15's own `restoreSnapshot` documents the same gap.
    //
    // This used to `return` a fabricated success — a row was selected, and a result
    // object claiming `restoredAt: new Date()` was handed back. `UpgradeService` read
    // that as `outcome: "rolled_back"`, so a failed upgrade reported to the console,
    // the CLI and the permanent `upgrade_attempts` record that the machine had been
    // put back, while the machine sat on the new image with its OS disk already
    // deleted. Failing is the honest answer until a restore exists: it routes the
    // attempt to `rollback_failed`, whose whole purpose is "real state unknown, needs
    // manual attention, here is the drift link".
    //
    // The `mode` and `options` arguments stay in the signature deliberately — the
    // shape a real rollback needs is already settled (see the header comment), and the
    // caller should not be rewritten twice.
    void mode;
    void options;
    return yield* Effect.fail(
      new SnapshotError({
        reason: "not_implemented",
        cause: `no automatic rollback exists yet; snapshot ${snapshotId} was not restored`,
      }),
    );
  });
