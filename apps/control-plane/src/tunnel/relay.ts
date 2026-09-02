// ---------------------------------------------------------------------------
// Composes the unmodified `TunnelServer` (DB rows + events — the "policy"
// layer) with `TunnelRegistry` (the actual live connections — the
// "transport" layer). Neither is touched by this file: `TunnelServer`'s
// `endSession`/`terminateSessionsForMachine` keep doing exactly what they
// did before this file existed (persist, emit), and `TunnelRegistry` keeps
// knowing nothing about the database. This is the piece that makes ending
// a session in the database actually end the live connection too — before
// this existed, `terminateSessionsForMachine` had zero production call
// sites and, even called directly, would have left a live browser<->daemon
// relay running with a database row saying the session was over.
// ---------------------------------------------------------------------------
import { machines, sessions } from "@cloudable/schema";
import { eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { isAuthorizedForInteractiveAccess } from "./access-authorization";
import { TunnelRegistry } from "./registry";
import { type EndSessionInput, TunnelError, TunnelServer } from "./server";

export interface TerminateSessionsForMachineInput {
  orgId: string;
  machineId: string;
  reason: string;
}

/**
 * `mintSession` deliberately has no wrapper here — creating a session
 * doesn't touch `TunnelRegistry` at all (nothing is registered until a
 * browser actually attaches, which is a separate not-yet-built handler);
 * callers that need to mint keep using `TunnelServer` directly.
 */
export class TunnelRelay extends Effect.Service<TunnelRelay>()("TunnelRelay", {
  effect: Effect.gen(function* () {
    const tunnelServer = yield* TunnelServer;
    const registry = yield* TunnelRegistry;

    /**
     * Ends one session: the real DB update + `access.session_ended` event
     * (`TunnelServer.endSession`, unchanged), then tears down the live
     * connection if one exists (`TunnelRegistry.closeRelay` — a no-op if
     * the browser never actually attached, e.g. a minted-but-unused token).
     * Registry teardown deliberately runs only after the DB write
     * succeeds — a session that's still "open" in the database should
     * never be reported to either leg as closed.
     */
    const endSession = (input: EndSessionInput): Effect.Effect<void, TunnelError> =>
      Effect.gen(function* () {
        yield* tunnelServer.endSession(input);
        yield* registry.closeRelay(input.sessionId, input.reason ?? "person_ended");
      });

    /**
     * Policy-triggered termination — must terminate live sessions on
     * policy change; disabling terminates live sessions.
     * Ends every live session on `machineId` in the database
     * first, then tears down every live connection for that machine —
     * same ordering rationale as `endSession`.
     */
    const terminateSessionsForMachine = (
      input: TerminateSessionsForMachineInput,
    ): Effect.Effect<number, TunnelError> =>
      Effect.gen(function* () {
        const count = yield* tunnelServer.terminateSessionsForMachine(input);
        yield* registry.closeAllForMachine(input.machineId, input.reason);
        return count;
      });

    return { endSession, terminateSessionsForMachine } as const;
  }),
}) {}

/**
 * Re-validates every currently open session's continued authorization and closes any that
 * no longer qualify — `TunnelServer.mintSession`/`access-authorization.ts`'s owner-or-
 * elevation gate only runs once, at mint time. Until this function, a session
 * opened on the strength of a valid elevation stayed live — both the DB row and, more to
 * the point, the actual registered tunnel connection — straight through that elevation's
 * `expiresAt`, until the person happened to end it themselves or some unrelated
 * machine-level event closed it. A break-glass grant that "expires on its own"
 * is not much of a boundary if the session it authorized keeps running afterward regardless.
 *
 * Same cadence/shape as the sibling expiry sweeps in `server.ts`'s `ExpirySweepLoopLive`
 * (`expireOverdueApprovals`/`expireOverdueSnapshots`/`expireOverdueElevations`), but this one
 * re-checks a *relationship* between two rows (still authorized?), not a single row's own
 * `expiresAt` — so it can't be one bulk `UPDATE` like its siblings. Each disqualified session
 * is closed individually through `TunnelRelay.endSession`, the exact same DB-write-then-
 * registry-teardown path any other end-session call uses (person-initiated or archive-
 * triggered) — this sweep is just a new, policy-driven caller of it.
 *
 * Reuses `isAuthorizedForInteractiveAccess` from `access-authorization.ts` verbatim — the
 * mint-time gate and this steady-state re-check are the same authorization question, asked
 * at two different moments, and must never drift apart into two separately-maintained
 * copies of "who's allowed on this machine". A null-owner machine, or a session belonging to
 * the machine's current owner, is exempt for the identical reason it's exempt at mint time.
 */
export const closeSessionsWithLapsedAuthorization = (): Effect.Effect<
  number,
  TunnelError,
  TunnelRelay | Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const relay = yield* TunnelRelay;

    const openSessions = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            sessionId: sessions.id,
            orgId: sessions.orgId,
            personId: sessions.personId,
            machineId: sessions.machineId,
            ownerPersonId: machines.ownerPersonId,
          })
          .from(sessions)
          .innerJoin(machines, eq(sessions.machineId, machines.id))
          .where(isNull(sessions.endedAt)),
      catch: (cause) => new TunnelError({ reason: "lookup_failed", cause }),
    });

    let closedCount = 0;
    for (const row of openSessions) {
      const authorized = yield* isAuthorizedForInteractiveAccess(db, {
        personId: row.personId,
        machineId: row.machineId,
        ownerPersonId: row.ownerPersonId,
      }).pipe(Effect.mapError((cause) => new TunnelError({ reason: "persist_failed", cause })));

      if (!authorized) {
        yield* relay.endSession({
          sessionId: row.sessionId,
          orgId: row.orgId,
          reason: "policy_terminated",
          actor: { actorType: "system", actorId: "session-reauthorization" },
        });
        closedCount++;
      }
    }

    return closedCount;
  });
