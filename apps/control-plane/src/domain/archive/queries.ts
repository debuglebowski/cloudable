import { machines, snapshots } from "@cloudable/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { ArchiveDbError, MachineNotFoundError, SnapshotNotFoundError } from "./errors";
import type { SnapshotRow } from "./snapshot";

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

export interface ListSnapshotsParams {
  orgId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ListSnapshotsResult {
  items: SnapshotRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SnapshotCursor {
  createdAt: Date;
  id: string;
}

const encodeSnapshotCursor = (row: Pick<SnapshotRow, "createdAt" | "id">): string =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");

const decodeSnapshotCursor = (cursor: string): SnapshotCursor | null => {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
};

/**
 * Org-scoped, cursor-paginated snapshot list — backs the Archive page (spec
 * §14/§20 "Archive is separate from Machines... governs retention"), which
 * needs to render every snapshot for an org, not just one by id. Same
 * `createdAt`+`id` composite-cursor pattern as `ApprovalService.list`.
 */
export const listSnapshotsByOrg = (
  params: ListSnapshotsParams,
): Effect.Effect<ListSnapshotsResult, ArchiveDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
    const cursor = params.cursor ? decodeSnapshotCursor(params.cursor) : null;

    const conditions = [eq(snapshots.orgId, params.orgId)];
    if (cursor) {
      const cursorCondition = or(
        lt(snapshots.createdAt, cursor.createdAt),
        and(eq(snapshots.createdAt, cursor.createdAt), lt(snapshots.id, cursor.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    const rows = yield* dbTry(
      () =>
        db
          .select()
          .from(snapshots)
          .where(and(...conditions))
          .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
          .limit(limit + 1),
      "list_snapshots_by_org",
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeSnapshotCursor(last) : null;

    return { items: page, nextCursor, hasMore };
  });
