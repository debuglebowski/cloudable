// ---------------------------------------------------------------------------
// Owner/elevation gate for interactive machine access. Admin
// connecting to a machine they do not own needs the elevation/break-glass
// primitive built in `domain/elevation/ElevationService.ts`. Until this
// module, `TunnelServer.mintSession` checked machine existence/state/tenancy
// and the access-method policy, but never who the requester actually is
// relative to the machine's owner — any org member could open a terminal
// against any machine in their org, owned by someone else or not, with zero
// elevation check, completely bypassing this whole model.
//
// Plain function taking a `db` handle directly — same convention
// `access-method-settings.ts` uses, so `mintSession` (which already has
// `db` in scope from its own `Db` yield) can call this without a second,
// redundant context requirement. Deliberately NOT routed through
// `ElevationRepoTag`/`ElevationService` — that port is narrow by design,
// scoped to what `ElevationService`'s own request/grant/expire flow needs,
// and adding a stray read-only query to it for an unrelated consumer would
// widen a boundary that exists specifically to keep that service's own
// tests mockable. This is a read-only existence check, not a domain
// operation, so it queries `elevations` directly, exactly the way the
// bulk `expireOverdueElevations` sweep (`ElevationService.ts`) already does.
// ---------------------------------------------------------------------------
import { elevations } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { and, eq, gt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * `personId` may open an interactive session (web terminal or SSH) against a
 * machine whose current `ownerPersonId` is `ownerPersonId`, and whose id is
 * `machineId`, when:
 *
 *  - the machine has no owner at all (`null`) — a machine mid-provisioning
 *    or mid owner-reassignment must not become inaccessible to every org
 *    member; a *live* machine always has exactly one
 *    owner, but this gate errs toward "not yet assigned" rather than
 *    "locked to nobody", and every access-method/tenancy check ahead of
 *    this one in `mintSession` already ran, so this is never the ONLY
 *    thing standing between a stranger and the machine; or
 *  - `personId` IS that owner; or
 *  - `personId` holds a currently `granted`, non-expired, `"shell"`-level
 *    elevation for exactly this machine (the admin-access primitive
 *    — see `domain/elevation/ElevationService.ts`). A weaker
 *    `"file_recovery"` grant does NOT satisfy this: the gate draws the
 *    line at "interactive shell — can read injected secrets on a live
 *    machine" being the higher-risk level this gate protects.
 */
export const isAuthorizedForInteractiveAccess = (
  db: DbHandle,
  input: { personId: string; machineId: string; ownerPersonId: string | null },
): Effect.Effect<boolean, Error> => {
  if (input.ownerPersonId === null || input.ownerPersonId === input.personId) {
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
            eq(elevations.level, "shell"),
            eq(elevations.status, "granted"),
            gt(elevations.expiresAt, now),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  });
};
