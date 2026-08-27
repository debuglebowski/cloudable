import { machines, snapshots } from "@cloudable/schema";
import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { ArchiveDbError, MachineNotFoundError, SnapshotNotFoundError } from "./errors";

export type MachineRow = typeof machines.$inferSelect;

/** Wraps a raw Drizzle call, translating any thrown/rejected error into `ArchiveDbError`
 * rather than letting the driver's own error type leak into the domain's error channel. */
export const dbTry = <A>(
  thunk: () => Promise<A>,
  reason: string,
): Effect.Effect<A, ArchiveDbError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      new ArchiveDbError({
        reason: `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

export const fetchMachine = (machineId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry(
      () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
      "fetch_machine",
    );
    const machine = rows[0];
    if (!machine) return yield* Effect.fail(new MachineNotFoundError({ machineId }));
    return machine;
  });

export const fetchSnapshot = (snapshotId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry(
      () => db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).limit(1),
      "fetch_snapshot",
    );
    const snapshot = rows[0];
    if (!snapshot) return yield* Effect.fail(new SnapshotNotFoundError({ snapshotId }));
    return snapshot;
  });

/** The most recently created snapshot of `machineId` for a given trigger — used by the
 * HTTP layer to report the snapshot `archiveMachine` just created, since that function's
 * own return type is `void` (see `archive.ts`). */
export const fetchLatestSnapshotForMachine = (
  machineId: string,
  trigger: (typeof snapshots.$inferSelect)["trigger"],
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry(
      () =>
        db
          .select()
          .from(snapshots)
          .where(and(eq(snapshots.machineId, machineId), eq(snapshots.trigger, trigger)))
          .orderBy(desc(snapshots.createdAt))
          .limit(1),
      "fetch_latest_snapshot_for_machine",
    );
    const snapshot = rows[0];
    if (!snapshot)
      return yield* Effect.fail(
        new ArchiveDbError({ reason: `no_${trigger}_snapshot_found_for_machine` }),
      );
    return snapshot;
  });
