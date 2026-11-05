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
import { and, eq, gt, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { config } from "../config";
import type { ElevationLevel } from "../domain/elevation/types";
import type { SessionMethod } from "./session-token";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * Which elevation levels satisfy a request for each session method.
 *
 * `shell` dominates: a person trusted with an interactive shell on a machine is already
 * trusted with its files, so listing it for `"files"` is not a widening. The reverse is
 * NOT true, and that asymmetry is the whole point of having two levels —
 * `docs/spec.md` §15 puts file recovery below interactive shell precisely because a shell
 * can read injected secrets on a live machine, and `domain/elevation/policy.ts` charges a
 * higher approval floor for it. A `file_recovery` grant opening a terminal would collapse
 * those back into one level and make the cheaper approval a route to the dearer one.
 */
const ACCEPTED_ELEVATION_LEVELS: Record<SessionMethod, ReadonlyArray<ElevationLevel>> = {
  terminal: ["shell"],
  ssh: ["shell"],
  files: ["file_recovery", "shell"],
};

/**
 * `personId` may open a session of `method` against a machine whose current
 * `ownerPersonId` is `ownerPersonId`, and whose id is `machineId`, when:
 *
 *  - `personId` IS that owner; or
 *  - the deployment allows admin access at all (`config.adminAccessPolicy` is not
 *    `never`, which is the default and what production pins), and `personId` holds a
 *    currently `granted`, non-expired elevation for exactly this machine at a level
 *    `ACCEPTED_ELEVATION_LEVELS[method]` accepts (see `domain/elevation/ElevationService.ts`).
 *
 * A machine with no owner (mid-offboarding, or archived) is open to nobody on the first
 * path. It used to be open to anyone in the org, on the reasoning that a machine waiting
 * for an owner should not be locked to everyone; but that is exactly the machine of a
 * person who just left, and its data is theirs.
 *
 * The policy is read here too, not only when an elevation is requested, so a grant made
 * before the pin (or before a redeploy that tightened it) stops working at once.
 *
 * `method` is not optional and has no default. Both callers — `mintSession` at grant time
 * and `closeSessionsWithLapsedAuthorization` in steady state — must ask the same question
 * about the same session, and a default would let the sweep quietly ask the terminal
 * question about a files session and close it a tick after it opened.
 */
export const isAuthorizedForInteractiveAccess = (
  db: DbHandle,
  input: {
    personId: string;
    machineId: string;
    ownerPersonId: string | null;
    method: SessionMethod;
  },
): Effect.Effect<boolean, Error> => {
  if (input.ownerPersonId !== null && input.ownerPersonId === input.personId) {
    return Effect.succeed(true);
  }
  if (config.adminAccessPolicy === "never") return Effect.succeed(false);

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
            inArray(elevations.level, [...ACCEPTED_ELEVATION_LEVELS[input.method]]),
            eq(elevations.status, "granted"),
            gt(elevations.expiresAt, now),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  });
};
