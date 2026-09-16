// ---------------------------------------------------------------------------
// Owner/elevation gate for READ-ONLY inspection of a snapshot's filesystem.
//
// This is deliberately a separate function from
// `tunnel/access-authorization.ts`'s `isAuthorizedForInteractiveAccess`, and
// the difference is one line — what a null owner means.
//
// That gate opens with `ownerPersonId === null || ownerPersonId === personId`
// and allows a null owner through. Correct for what it guards: a machine
// mid-provisioning or mid owner-reassignment must not become unreachable to
// the whole org, and a live machine always has exactly one owner.
//
// Here the same condition is a hole. `offboardPerson.ts` clears the owner and
// THEN archives, so every snapshot produced by offboarding belongs to a
// machine whose `ownerPersonId` is null. Reusing that gate would mean any
// member of the org could read a departed colleague's home directory with no
// elevation, no approval, and no reason recorded — precisely the case this
// whole feature exists to govern.
//
// So for a snapshot, a null owner is CLOSED, not open. It means "offboarded",
// not "not yet assigned", and the people who may still look are the ones who
// went through elevation to get there.
//
// Nothing here is a widening of that other gate and nothing should be
// refactored into shared code with it: they ask the same question about
// different objects and reach opposite conclusions on the case that matters.
//
// Plain function over a `db` handle, matching `access-authorization.ts`'s own
// convention — callers already have `db` in scope, and this is a read-only
// existence check rather than a domain operation, so it queries `elevations`
// directly rather than widening `ElevationRepoTag`.
// ---------------------------------------------------------------------------
import { elevations } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import type { ElevationLevel } from "../elevation/types";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * The same pair `"files"` accepts on a live machine, for the same reason: `shell`
 * dominates `file_recovery`, so someone trusted with a shell on the machine is already
 * trusted with what was on its disk. The reverse must never hold.
 *
 * Inspection is not charged a level of its own. It is strictly less than a live files
 * session — read-only, no write/rename/upload, and against a frozen copy rather than a
 * running machine — so requiring MORE than `file_recovery` would make the safer operation
 * the harder one to reach, and anyone blocked would simply restore the snapshot instead,
 * which is a bigger grant.
 */
const ACCEPTED_ELEVATION_LEVELS: ReadonlyArray<ElevationLevel> = ["file_recovery", "shell"];

/**
 * `personId` may inspect a snapshot of the machine `machineId`, whose current owner is
 * `ownerPersonId`, when:
 *
 *  - `personId` IS that owner — their own data, and they could have read it on the live
 *    machine before it was archived; or
 *  - `personId` holds a currently `granted`, non-expired elevation on exactly this machine
 *    at `file_recovery` or `shell`.
 *
 * A null owner satisfies NEITHER and falls through to the elevation check. See this file's
 * header for why that is the opposite of the live-access gate and must stay that way.
 *
 * Note this is per-MACHINE, not per-snapshot: an elevation is granted against a machine,
 * and a machine's snapshots are all copies of that same machine's disks. Someone cleared
 * to recover a file from it is cleared for the copies of it.
 */
export const isAuthorizedToInspectSnapshot = (
  db: DbHandle,
  input: {
    personId: string;
    machineId: string;
    ownerPersonId: string | null;
  },
): Effect.Effect<boolean, Error> => {
  if (input.ownerPersonId !== null && input.ownerPersonId === input.personId) {
    return Effect.succeed(true);
  }

  return Effect.gen(function* () {
    const now = new Date();
    const rows = yield* Effect.tryPromise(() =>
      db
        .select({ id: elevations.id })
        .from(elevations)
        .where(
          and(
            eq(elevations.personId, input.personId),
            eq(elevations.machineId, input.machineId),
            inArray(elevations.level, [...ACCEPTED_ELEVATION_LEVELS]),
            eq(elevations.status, "granted"),
            gt(elevations.expiresAt, now),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  });
};
