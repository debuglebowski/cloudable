import { machines, sessions } from "@cloudable/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../db/layer";

export class SessionQueryError extends Data.TaggedError("SessionQueryError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface SessionForAttach {
  id: string;
  orgId: string;
  machineId: string;
  personId: string;
  sessionToken: string | null;
  endedAt: Date | null;
}

/**
 * The raw fields the browser-attach route (`http/handlers/tunnel.ts`) needs to authorize an
 * attach and replay the stored token to the daemon: `sessions.orgId === currentUser.orgId &&
 * sessions.personId === currentUser.personId && endedAt IS NULL` (the plan's own stated
 * authorization rule — deliberately not "any admin can attach to anyone's session", that's
 * the elevation-approval machinery's job, not a bypass added here). Returns `undefined` for a
 * nonexistent id rather than failing — "not found" and "found but not authorized" are handled
 * identically by the caller (a 404, not a 403, leaking nothing about whether the id exists).
 */
export const fetchSessionForAttach = (
  sessionId: string,
): Effect.Effect<SessionForAttach | undefined, SessionQueryError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: sessions.id,
            orgId: sessions.orgId,
            machineId: sessions.machineId,
            personId: sessions.personId,
            sessionToken: sessions.sessionToken,
            endedAt: sessions.endedAt,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1),
      catch: (cause) => new SessionQueryError({ reason: "query_failed", cause }),
    });
    return rows[0];
  });

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
 * has no other way to show which machine a session is on. Small,
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
