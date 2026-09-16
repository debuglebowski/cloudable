import { Duration, Effect } from "effect";
import { openPostgres } from "../db/connect";
import type { Db } from "../db/layer";
import { expireOverdueSnapshots } from "../domain/archive/snapshot";
import { expireOverdueElevations } from "../domain/elevation/ElevationService";
import { expireOverdueApprovals } from "../services/ApprovalService";
import type { EventBus } from "../services/EventBus";
import { type TunnelRelay, closeSessionsWithLapsedAuthorization } from "../tunnel/relay";

/**
 * The wiring four separate sweeps each assumed someone else had done.
 *
 * `expireOverdueApprovals`, `expireOverdueSnapshots`, `expireOverdueElevations` and
 * `closeSessionsWithLapsedAuthorization` were all written, exported, tested — and
 * never called. `tunnel/relay.ts` described their shared cadence as belonging to an
 * `ExpirySweepLoopLive` in `server.ts`; no such layer existed. Grepping for any of
 * them found definitions and doc-comment cross-references, which reads exactly like
 * working code.
 *
 * What that cost, in production: snapshots past `expiresAt` were never expired, so
 * an org's `retentionDefaultDays` was a number in a settings page and nothing else.
 * Approvals stayed pending for ever. Elevations stayed `granted` in the console past
 * their expiry — new access was still refused, `isAuthorizedForInteractiveAccess`
 * re-checks `expiresAt` live on every mint, but a session already opened on a
 * now-expired grant kept running, which is the precise scenario
 * `closeSessionsWithLapsedAuthorization`'s own doc comment exists to rule out.
 *
 * Modelled on `status-refresh/daemon.ts`, including its advisory-lock leader election,
 * for a reason that matters more here than there: these sweeps publish events, and
 * events are append-only. Two replicas sweeping the same overdue approval would
 * publish `approval.expired` twice, permanently. Reconcile's duplicate work is
 * merely redundant; this would be a corrupt audit record.
 */

/** Distinct from every other advisory-lock key in this codebase, each on its own
 * dedicated `max:1` connection (`pg_advisory_lock`/`unlock` are session-scoped):
 * `status-refresh/daemon.ts`'s `RECONCILE_LEADER_LOCK_KEY = 522_038_916`,
 * `migrate-on-boot.ts`'s `615_930_744`, `bootstrap-default-admin.ts`'s `394_812_207`,
 * `test-support/db.ts`'s `847_291_003`. Held for the life of the process, like
 * reconcile's: whichever replica acquires it is the sole sweeper, and if it dies
 * Postgres drops the lock and the next blocked replica takes over. */
const EXPIRY_LEADER_LOCK_KEY = 738_164_502;

/** Every sweep here is a handful of indexed DB queries — no cloud API calls, nothing
 * like the per-machine ARM round trips that set `RECONCILE_INTERVAL` to two minutes.
 * The binding constraint is staleness, not cost: an elevation that has expired should
 * stop showing as `granted`, and the session it authorized should close, in a time a
 * person would call "promptly" rather than "eventually". A minute is that, and it is
 * still 60x cheaper per pass than reconcile. */
const SWEEP_INTERVAL = Duration.seconds(60);

/** Same rationale as `status-refresh/daemon.ts`'s keepalive: `pg_advisory_lock` never
 * pushes a "you lost it" notification, so the only way to notice a silently dropped
 * connection is to use it. Bounds how long two replicas could both believe they lead. */
const KEEPALIVE_INTERVAL = Duration.seconds(30);

/** How long to wait before retrying after losing or failing to acquire leadership, so
 * a persistently-failing Postgres doesn't spin this fiber. */
const RETRY_BACKOFF = Duration.seconds(10);

/**
 * One pass over all four sweeps.
 *
 * Each is run independently and its failure caught and logged, rather than letting
 * the first one to fail abandon the other three: they share only a cadence, not a
 * transaction, and a broken snapshot sweep is no reason to stop expiring elevations.
 * A pass that logs four warnings is a visibly broken pass; a pass that silently did
 * one quarter of its job is not.
 */
/** Every sweep reports failure as a tagged error carrying a `reason` (`ApprovalError`,
 * `ArchiveDbError`, `ElevationInfraError`, `TunnelError` — four separate unions with
 * no common supertype). Read defensively rather than widening any of them for the
 * sake of one log line here. */
const describeError = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);
  const e = error as { _tag?: unknown; reason?: unknown; message?: unknown };
  const tag = typeof e._tag === "string" ? e._tag : "error";
  const detail =
    typeof e.reason === "string"
      ? e.reason
      : typeof e.message === "string"
        ? e.message
        : String(error);
  return `${tag}: ${detail}`;
};

/**
 * One sweep, its failure caught and logged rather than propagated.
 *
 * The four share only a cadence, not a transaction: a broken snapshot sweep is no
 * reason to stop expiring elevations, and a pass that logs four warnings is visibly
 * broken in a way that a pass which silently did a quarter of its job is not.
 *
 * Only a sweep that actually changed something logs on success — at a 60s cadence,
 * a line per no-op pass would bury the ones that mattered.
 */
const runSweep = <R>(
  name: string,
  sweep: Effect.Effect<number, unknown, R>,
): Effect.Effect<void, never, R> =>
  sweep.pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(`expiry sweep: ${name} failed this pass: ${describeError(error)}`).pipe(
        Effect.as(0),
      ),
    ),
    Effect.flatMap((count) =>
      count > 0 ? Effect.logInfo(`expiry sweep: expired ${count} ${name}`) : Effect.void,
    ),
  );

const runSweepPass: Effect.Effect<void, never, Db | EventBus | TunnelRelay> = Effect.gen(
  function* () {
    yield* runSweep("approvals", expireOverdueApprovals);
    yield* runSweep("snapshots", expireOverdueSnapshots());
    yield* runSweep("elevations", expireOverdueElevations);
    yield* runSweep("sessions with lapsed authorization", closeSessionsWithLapsedAuthorization());
  },
);

/**
 * Loops forever: acquire the leader lock (blocks until held), then run `runSweepPass`
 * every `SWEEP_INTERVAL`, raced against a keepalive on the lock connection. If the
 * race resolves — the keepalive fails, meaning the connection and therefore the lock
 * is gone — the connection is closed, a warning logged, and the cycle retries after
 * `RETRY_BACKOFF`. Never lets a failure propagate out and kill the daemon fiber.
 */
export const startExpirySweepDaemon: Effect.Effect<never, never, Db | EventBus | TunnelRelay> =
  Effect.gen(function* () {
    while (true) {
      // `openPostgres`, not `postgres(config.databaseUrl)` — under
      // DATABASE_AUTH_MODE=entra the connection string carries no password, so
      // building a client directly sends an empty one and every acquisition fails
      // with an error that reads like a lock problem and is an auth one. Same trap
      // `status-refresh/daemon.ts` documents falling into in a real deployment.
      const lockSql = openPostgres({ max: 1 });
      const acquired = yield* Effect.tryPromise({
        try: () => lockSql`select pg_advisory_lock(${EXPIRY_LEADER_LOCK_KEY})`,
        catch: (cause) => cause,
      }).pipe(
        Effect.as(true),
        Effect.catchAll((cause) =>
          Effect.logWarning(
            `expiry daemon: failed to acquire leader lock, retrying: ${String(cause)}`,
          ).pipe(Effect.as(false)),
        ),
      );

      if (!acquired) {
        yield* Effect.tryPromise({ try: () => lockSql.end(), catch: () => undefined }).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.sleep(RETRY_BACKOFF);
        continue;
      }

      yield* Effect.logInfo("expiry daemon: acquired leader lock, starting sweep passes");

      const keepAlive: Effect.Effect<never, unknown> = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(KEEPALIVE_INTERVAL);
          yield* Effect.tryPromise({ try: () => lockSql`select 1`, catch: (cause) => cause });
        }
      });

      const sweeping: Effect.Effect<never, never, Db | EventBus | TunnelRelay> = Effect.gen(
        function* () {
          while (true) {
            yield* runSweepPass;
            yield* Effect.sleep(SWEEP_INTERVAL);
          }
        },
      );

      yield* Effect.race(sweeping, keepAlive).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(`expiry daemon: lost leadership: ${String(cause)}`),
        ),
      );

      yield* Effect.tryPromise({ try: () => lockSql.end(), catch: () => undefined }).pipe(
        Effect.catchAll(() => Effect.void),
      );
      yield* Effect.sleep(RETRY_BACKOFF);
    }
  });
