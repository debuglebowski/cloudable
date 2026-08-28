import { machines, sessions } from "@cloudable/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../db/layer";

export class SessionQueryError extends Data.TaggedError("SessionQueryError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface ActiveSessionRow {
  id: string;
  orgId: string;
  machineId: string;
  machineName: string;
  personId: string;
  method: "terminal" | "ssh";
  osUser: string;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * Currently-open sessions for an org (`endedAt IS NULL`), joined against
 * `machines` for a display name — the Access page's "active sessions" table
 * (spec §20) has no other way to show which machine a session is on. Small,
 * ungrown-yet dataset (real sessions are short-lived), so no cursor
 * pagination unlike `listSnapshotsByOrg`/`ApprovalService.list`.
 */
export const listActiveSessionsByOrg = (
  orgId: string,
): Effect.Effect<ActiveSessionRow[], SessionQueryError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: sessions.id,
            orgId: sessions.orgId,
            machineId: sessions.machineId,
            machineName: machines.name,
            personId: sessions.personId,
            method: sessions.method,
            osUser: sessions.osUser,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
          })
          .from(sessions)
          .innerJoin(machines, eq(sessions.machineId, machines.id))
          .where(and(eq(sessions.orgId, orgId), isNull(sessions.endedAt)))
          .orderBy(desc(sessions.startedAt)),
      catch: (cause) => new SessionQueryError({ reason: "query_failed", cause }),
    });
  });
