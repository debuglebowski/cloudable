import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { machines, snapshots } from "@cloudable/schema";
import { Db } from "../../db/layer";

/**
 * ============================================================================
 * STUB — CONSOLIDATE WITH UNIT 15 ONCE ITS PR MERGES.
 * ============================================================================
 * Unit 15 is concurrently building `apps/control-plane/src/domain/archive/*`
 * with the real `createSnapshot(machineId, trigger)` / restore primitives.
 * At the time this unit was written, that directory did not exist yet, so
 * this file defines `createSnapshot` / `restoreSnapshot` with the same
 * signatures the task description specifies, scoped to this unit's own
 * `domain/upgrade/*` directory so it can't collide with unit 15's files.
 *
 * Once unit 15 merges:
 *   1. delete this file and `snapshot-port.test.ts`,
 *   2. import `createSnapshot` / `restoreSnapshot` from unit 15's module in
 *      `UpgradeService.ts` instead,
 *   3. reconcile any signature drift (this stub's `RestoreSnapshotOptions`
 *      and `CreateSnapshotResult` shapes are a best guess — unit 15's real
 *      ones win).
 * ============================================================================
 */

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  reason: "machine_not_found" | "snapshot_not_found" | "db_error";
  cause?: unknown;
}> {}

export type SnapshotTrigger = "archive" | "upgrade" | "manual";
export type RestoreMode = "data" | "config" | "full";

export interface CreateSnapshotResult {
  snapshotId: string;
  machineId: string;
  trigger: SnapshotTrigger;
  createdAt: Date;
}

export interface RestoreSnapshotOptions {
  targetMachineId: string;
  /**
   * Spec §14 restore modes are escalating-approval, gated by the §13
   * approval object for HUMAN-initiated restores. `null` here means a
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

// Spec §14: "Retention default 30 days, org-configurable." A real
// implementation resolves the org's configured retention setting; this stub
// hardcodes the default since org settings resolution is out of this unit's
// scope.
const DEFAULT_RETENTION_DAYS = 30;

export const createSnapshot = (
  machineId: string,
  trigger: SnapshotTrigger,
): Effect.Effect<CreateSnapshotResult, SnapshotError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const machineRows = yield* Effect.tryPromise({
      try: () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
      catch: (cause) => new SnapshotError({ reason: "db_error", cause }),
    });
    const machine = machineRows[0];
    if (!machine) {
      return yield* Effect.fail(new SnapshotError({ reason: "machine_not_found", cause: machineId }));
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(snapshots)
          .values({
            orgId: machine.orgId,
            machineId: machine.id,
            trigger,
            region: machine.region,
            // Unknown until a real disk snapshot is taken — see file header.
            sizeBytes: null,
            retentionDays: DEFAULT_RETENTION_DAYS,
            createdAt: now,
            expiresAt,
          })
          .returning(),
      catch: (cause) => new SnapshotError({ reason: "db_error", cause }),
    });

    const row = rows[0];
    if (!row) {
      return yield* Effect.fail(new SnapshotError({ reason: "db_error", cause: "insert returned no row" }));
    }

    return { snapshotId: row.id, machineId: machine.id, trigger, createdAt: row.createdAt };
  });

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
      return yield* Effect.fail(new SnapshotError({ reason: "snapshot_not_found", cause: snapshotId }));
    }

    // STUB: a real restore reattaches the snapshotted volume/config to
    // `options.targetMachineId` via `ProvisioningService` and emits
    // `snapshot.restored` (see `packages/events/src/domains/snapshot.ts`).
    // That mechanism belongs to unit 15; `UpgradeService` only needs this
    // result shape to complete its own rollback bookkeeping today.
    return {
      snapshotId,
      targetMachineId: options.targetMachineId,
      mode,
      restoredAt: new Date(),
    };
  });
