import { elevations, machines } from "@cloudable/schema";
import { desc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

export class ElevationQueryError extends Data.TaggedError("ElevationQueryError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface ElevationListRow {
  id: string;
  personId: string;
  machineId: string;
  machineName: string;
  level: "file_recovery" | "shell";
  reason: string;
  status: "requested" | "granted" | "expired" | "denied";
  expiresAt: Date | null;
}

/**
 * Org-scoped elevation list, joined against `machines` for a display name —
 * separate from `ElevationRepo` (the narrow write-side port `ElevationService`
 * depends on and unit-tests against an in-memory fake) since this is a
 * read-only console concern with no bearing on the grant/deny state machine.
 * Small dataset (time-boxed grants), so no cursor pagination.
 */
export const listElevationsByOrg = (
  orgId: string,
): Effect.Effect<ElevationListRow[], ElevationQueryError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: elevations.id,
            personId: elevations.personId,
            machineId: elevations.machineId,
            machineName: machines.name,
            level: elevations.level,
            reason: elevations.reason,
            status: elevations.status,
            expiresAt: elevations.expiresAt,
          })
          .from(elevations)
          .innerJoin(machines, eq(elevations.machineId, machines.id))
          .where(eq(elevations.orgId, orgId))
          .orderBy(desc(elevations.expiresAt)),
      catch: (cause) => new ElevationQueryError({ reason: "query_failed", cause }),
    });
  });
