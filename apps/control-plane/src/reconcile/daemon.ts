import { Duration, Effect } from "effect";
import { openPostgres } from "../db/connect";
import type { Db } from "../db/layer";
import type { MachineService } from "../domain/machine/MachineService";
import type { EventBus } from "../services/EventBus";
import type { ProvisioningServiceTag } from "../services/ProvisioningService";
import { listReconcilableMachines } from "./list-machines";
import { runReconcileLoop } from "./loop";
import { persistReconcileResult } from "./persist-result";

/** Distinct from every other lock key already in use in this codebase (each on its
 * own dedicated `max:1` connection, since `pg_advisory_lock`/`unlock` are scoped to
 * one physical session — same reasoning, same convention):
 * `migrate-on-boot.ts`'s `BOOT_MIGRATION_ADVISORY_LOCK_KEY = 615_930_744`,
 * `bootstrap-default-admin.ts`'s `BOOTSTRAP_ADVISORY_LOCK_KEY = 394_812_207`,
 * `test-support/db.ts`'s `MIGRATION_ADVISORY_LOCK_KEY = 847_291_003`. Those three
 * acquire briefly and release; this one is held for the life of the process — the
 * standard advisory-lock leader-election pattern: whichever replica's
 * `pg_advisory_lock()` call resolves first becomes the sole active reconciler, and
 * if it dies or its connection drops, Postgres releases the lock automatically and
 * the next replica's blocked call takes over. */
const RECONCILE_LEADER_LOCK_KEY = 522_038_916;

/** No prior art for this cadence — `docs/agents.md` only documents the *agent's*
 * own ~30s local poll, a cheaper, different operation than this loop's per-machine
 * live Azure ARM calls. Frequent enough that a machine whose agent never checks in
 * gets a real status within a couple of minutes, not hours; not so frequent that a
 * growing fleet hammers Azure's ARM API. One constant, easy to retune. */
const RECONCILE_INTERVAL = Duration.minutes(2);

/** How often the leader checks its own lock connection is still alive, by running a
 * trivial query on it. `pg_advisory_lock` has no push notification for "you lost the
 * lock" — the only way to know the connection (and therefore the lock) is gone is to
 * actively use it. 30s bounds how long two replicas could theoretically both believe
 * they're the leader after a silent connection drop; `reconcileMachine`'s one
 * genuinely dangerous branch (calling `create()` again for a `null`/`"missing"`
 * `lastKnown`) is structurally unreachable via `listReconcilableMachines` (it never
 * produces either), so the real cost of that narrow window is bounded to redundant,
 * idempotent reconcile work, not double-provisioning. */
const KEEPALIVE_INTERVAL = Duration.seconds(30);

/** How long to wait before retrying after losing (or failing to acquire) leadership,
 * so a persistently-failing Postgres doesn't spin this fiber in a tight loop. */
const RETRY_BACKOFF = Duration.seconds(10);

/**
 * The wiring `reconcile/loop.ts`'s own doc comment left undone: "callers decide how
 * to run this — e.g. `Effect.forkDaemon` it during server startup." Nothing ever
 * did. This is that caller.
 *
 * Loops forever: acquire the leader lock (blocks until held), then run
 * `runReconcileLoop` against the real `listReconcilableMachines`/`persistReconcileResult`
 * pair, raced against a periodic keepalive on the lock connection so a silently
 * dropped connection is noticed and acted on (see `KEEPALIVE_INTERVAL`) instead of
 * leaving this replica believing it's still the leader indefinitely. If the race
 * ever resolves — the keepalive fails, or `listMachines` itself fails hard enough to
 * end `runReconcileLoop` — the lock connection is closed, a warning is logged, and
 * the whole cycle retries after `RETRY_BACKOFF`. This Effect's own type never
 * resolves under normal operation (`Effect.Effect<never, ...>`) and must never let a
 * failure propagate out and crash the daemon fiber for good.
 */
export const startReconcileDaemon: Effect.Effect<
  never,
  never,
  Db | ProvisioningServiceTag | MachineService | EventBus
> = Effect.gen(function* () {
  while (true) {
    // openPostgres, not postgres(config.databaseUrl, ...): under
    // DATABASE_AUTH_MODE=entra the connection string carries no password at
    // all, so building a client directly here sends an empty one and every
    // acquisition fails with "Password returned by client is empty" — which
    // reads like a lock problem and is actually an auth one. That silently
    // killed reconciliation in a real deployment; the daemon logs a warning
    // and retries forever, so nothing crashes and nothing reconciles.
    const lockSql = openPostgres({ max: 1 });
    const acquired = yield* Effect.tryPromise({
      try: () => lockSql`select pg_advisory_lock(${RECONCILE_LEADER_LOCK_KEY})`,
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.catchAll((cause) =>
        Effect.logWarning(
          `reconcile daemon: failed to acquire leader lock, retrying: ${String(cause)}`,
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

    yield* Effect.logInfo("reconcile daemon: acquired leader lock, starting reconcile passes");

    const keepAlive: Effect.Effect<never, unknown> = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(KEEPALIVE_INTERVAL);
        yield* Effect.tryPromise({ try: () => lockSql`select 1`, catch: (cause) => cause });
      }
    });

    // `onResult`/`onError` on `ReconcileLoopConfig` are deliberately hardcoded to
    // `Effect.Effect<void>` (no generic R) even though `listMachines` threads its own
    // context through — `persistReconcileResult` needs `Db | EventBus`, so the
    // ambient context this whole daemon Effect already carries is captured once here
    // and re-provided into it explicitly, rather than widening `loop.ts`'s own,
    // already-tested type (`onResult`'s asymmetry vs `listMachines` is that file's
    // existing design, not something to work around by editing it).
    const persistenceContext = yield* Effect.context<Db | EventBus>();

    const reconcile = runReconcileLoop({
      listMachines: listReconcilableMachines,
      interval: RECONCILE_INTERVAL,
      onResult: (result) => Effect.provide(persistReconcileResult(result), persistenceContext),
      // `${error}` alone prints the tag and nothing else; `.message` is where each
      // error type puts the reason and, for `ProvisioningError`, whatever Azure or
      // Docker actually said.
      onError: (machineId, error) =>
        Effect.logWarning(
          `reconcile: machine ${machineId} failed this pass: ${error._tag}: ${error.message}`,
        ),
    });

    yield* Effect.race(reconcile, keepAlive).pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning(
          `reconcile daemon: lost leadership or reconcile loop ended: ${String(cause)}`,
        ),
      ),
    );

    yield* Effect.tryPromise({ try: () => lockSql.end(), catch: () => undefined }).pipe(
      Effect.catchAll(() => Effect.void),
    );
    yield* Effect.sleep(RETRY_BACKOFF);
  }
});
