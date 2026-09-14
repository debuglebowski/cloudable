#!/usr/bin/env bun
/**
 * One-off repair for `sessions` rows that were never closed.
 *
 * Until `endSessionOnDisconnect` (`http/handlers/tunnel.ts`), the only thing that
 * ever set `sessions.endedAt` was an explicit `POST /api/v1/access/sessions/end`,
 * and `cloudable connect` sends that on Ctrl-] and on no other path. A socket that
 * dropped, a Ctrl-C, a closed terminal, an attach that never completed — all left
 * the row open for ever. `listActiveSessionsByOrg` filters on `endedAt IS NULL`, so
 * the Access tab counted every one of them as a live shell.
 *
 * That is fixed going forward. This closes the rows already stranded behind it.
 *
 * WHY durationSeconds IS 0, NOT `now - startedAt`
 *
 * `TunnelServer.endSession` computes the duration from `startedAt` to now, which for
 * a row stranded two days ago would write "this session lasted two days" into
 * `access.session_ended`. Events are append-only: that number would be permanent,
 * plausible, and false. The session's real duration is not recoverable — nothing
 * recorded when the leg actually dropped — so this writes 0 as an explicit unknown,
 * alongside `reason: "backfill_never_closed"` which says why. An auditor reading the
 * record sees a session whose end was never captured and was closed retroactively.
 * That is the true statement available.
 *
 * `occurredAt` is now, not `startedAt`, for the same reason: now is when we
 * determined the session was over, which is a fact. When it actually ended is not.
 *
 * SAFETY
 *
 * Dry run unless `--apply` is passed. Only touches sessions older than
 * `--older-than` (default 1h), so a genuinely live session is never closed — run it
 * after deploying the fix, and anything still open past the cutoff is stranded by
 * definition. `--org <uuid>` narrows further.
 *
 * Usage, from the repo root:
 *   bun run --cwd apps/control-plane scripts/backfill-unclosed-sessions.ts
 *   bun run --cwd apps/control-plane scripts/backfill-unclosed-sessions.ts --apply
 *
 * DATABASE_URL must point at the database to repair.
 */
import { machines, sessions } from "@cloudable/schema";
import { and, eq, isNull, lt } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db, DbLive } from "../src/db/layer";
import { EventBus } from "../src/services/EventBus";

const APPLY = process.argv.includes("--apply");

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Hours. A session still open this long after the disconnect fix is deployed did not
 * end cleanly — nothing keeps a real terminal attached that long without traffic. */
const olderThanHours = Number(flag("--older-than") ?? "1");
const onlyOrgId = flag("--org");

const REASON = "backfill_never_closed";

const program = Effect.gen(function* () {
  if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
    yield* Effect.logError(`--older-than must be a non-negative number of hours`);
    return 1;
  }

  const db = yield* Db;
  const eventBus = yield* EventBus;
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);

  const stranded = yield* Effect.promise(() =>
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
      })
      .from(sessions)
      .innerJoin(machines, eq(sessions.machineId, machines.id))
      .where(
        and(
          isNull(sessions.endedAt),
          lt(sessions.startedAt, cutoff),
          ...(onlyOrgId ? [eq(sessions.orgId, onlyOrgId)] : []),
        ),
      )
      .orderBy(sessions.startedAt),
  );

  if (stranded.length === 0) {
    yield* Effect.logInfo(
      `no sessions open longer than ${olderThanHours}h${onlyOrgId ? ` in org ${onlyOrgId}` : ""} — nothing to do`,
    );
    return 0;
  }

  yield* Effect.logInfo(
    `${stranded.length} session(s) open longer than ${olderThanHours}h${APPLY ? "" : " — DRY RUN, pass --apply to write"}:`,
  );
  for (const row of stranded) {
    const ageHours = ((now.getTime() - row.startedAt.getTime()) / 3_600_000).toFixed(1);
    yield* Effect.logInfo(
      `  ${row.id}  ${row.machineName}  ${row.method}/${row.osUser}  started ${row.startedAt.toISOString()}  (${ageHours}h ago)`,
    );
  }

  if (!APPLY) return 0;

  // One row at a time, each guarded by `isNull(endedAt)` again: between the select
  // above and this write, a real end (a person, or the disconnect path) may have
  // closed the row legitimately, and that end is the true one. A no-op update means
  // exactly that happened — skip it, and publish nothing.
  let closed = 0;
  for (const row of stranded) {
    const updated = yield* Effect.promise(() =>
      db
        .update(sessions)
        .set({ endedAt: now, durationSeconds: 0, terminationReason: REASON })
        .where(and(eq(sessions.id, row.id), isNull(sessions.endedAt)))
        .returning({ id: sessions.id }),
    );
    if (updated.length === 0) {
      yield* Effect.logInfo(`  ${row.id} was closed by something else first — left alone`);
      continue;
    }

    yield* eventBus
      .publish([
        {
          id: "",
          recordedAt: now,
          type: "access.session_ended",
          occurredAt: now,
          orgId: row.orgId,
          actorType: "system",
          actorId: "session-backfill",
          machineId: row.machineId,
          correlationId: row.id,
          schemaVersion: 1,
          payload: { durationSeconds: 0, reason: REASON },
        },
      ])
      .pipe(
        Effect.catchAll((error) =>
          // The row is already closed at this point. Losing the event is bad, but
          // re-opening the row to "undo" would be worse, and the next run would then
          // try to close it again. Report loudly and carry on.
          Effect.logError(`  ${row.id} closed, but its event failed to publish: ${String(error)}`),
        ),
      );
    closed++;
  }

  yield* Effect.logInfo(`closed ${closed} stranded session(s) with reason "${REASON}"`);
  return 0;
});

const exitCode = await Effect.runPromise(
  program.pipe(
    Effect.provide(Layer.mergeAll(EventBus.Default.pipe(Layer.provide(DbLive)), DbLive)),
  ),
);
process.exit(exitCode);
