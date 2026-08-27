import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { Db } from "../db/layer";

/**
 * Finding-age helper: persists a stable `firstSeenAt` per
 * `(checkId, orgId, machineId, detailKey)` so a finding's age survives
 * across `evaluate` reruns instead of resetting to "now" every time.
 *
 * DUPLICATION NOTE for reviewers / unit 7's owner: per the unit 8 brief,
 * unit 7 is concurrently building the canonical version of this file,
 * backed by a proper `complianceFindingState` table declared (with a real
 * migration) in `packages/schema`. As of this branch's fork point that
 * hadn't landed on `main` yet, so this is a minimal standalone
 * implementation with the identical exported signature
 * (`upsertFindingFirstSeen(checkId, orgId, machineId, detailKey): Effect<Date>`)
 * so swapping it out later is call-site-free. To avoid two units racing to
 * add the same `packages/schema` migration, this version manages its own
 * ad-hoc table via a lazy `CREATE TABLE IF NOT EXISTS` instead of a
 * migration. Once unit 7 merges, delete this file's body (and drop the
 * ad-hoc table) in favor of theirs.
 */

// Only needs `Db`'s `.execute` — untyped on the schema generic so this
// placeholder doesn't have to import `@cloudable/schema` a second time.
type Executable = Pick<PostgresJsDatabase, "execute">;

// Memoized per-`Db`-instance (not just per-process!) so the DDL only runs
// once per connection, not on every finding. Keyed by a `WeakMap` on the
// `db` object itself, rather than a single module-level flag, because more
// than one `Db` instance can be alive in one process — e.g. each test file
// in this same `bun test` run provisions its own Testcontainers Postgres —
// and a bare singleton would only ever create the table against whichever
// `Db` happened to call `ensureTable` first, leaving every other instance's
// database without the table.
//
// NOTE: `db.execute(...)` returns a lazy, re-executable thenable (like the
// rest of Drizzle's query builders) rather than a settled Promise — merely
// storing that object and `await`-ing it repeatedly would re-run the
// `CREATE TABLE` on every call. Wrapping it in `Promise.resolve` forces the
// driver call to happen exactly once (native Promise adoption runs a
// thenable's `.then` a single time) and caches the settled result.
const tableReadyByDb = new WeakMap<Executable, Promise<void>>();

function ensureTable(db: Executable): Promise<void> {
  let ready = tableReadyByDb.get(db);
  if (!ready) {
    ready = Promise.resolve(
      db.execute(sql`
        CREATE TABLE IF NOT EXISTS compliance_finding_state (
          check_id text NOT NULL,
          org_id uuid NOT NULL,
          machine_id uuid,
          detail_key text NOT NULL,
          first_seen_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (check_id, org_id, machine_id, detail_key)
        )
      `),
    ).then(() => undefined);
    tableReadyByDb.set(db, ready);
  }
  return ready;
}

/**
 * Returns the stable `firstSeenAt` for the given finding key. The first
 * call for a key records "now"; every later call for the same key returns
 * that same timestamp unchanged.
 */
export const upsertFindingFirstSeen = (
  checkId: string,
  orgId: string,
  machineId: string | null,
  detailKey: string,
): Effect.Effect<Date, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    yield* Effect.orDie(Effect.tryPromise(() => ensureTable(db)));

    const rows = yield* Effect.orDie(
      Effect.tryPromise(() =>
        db.execute<{ first_seen_at: string }>(sql`
          INSERT INTO compliance_finding_state (check_id, org_id, machine_id, detail_key)
          VALUES (${checkId}, ${orgId}, ${machineId}, ${detailKey})
          ON CONFLICT (check_id, org_id, machine_id, detail_key)
          DO UPDATE SET check_id = compliance_finding_state.check_id
          RETURNING first_seen_at
        `),
      ),
    );

    // Raw `db.execute` (unlike Drizzle's typed query builder) doesn't run
    // column-level type mappers, so `first_seen_at` comes back as the
    // driver's raw timestamptz string, not a `Date`.
    const [row] = rows as unknown as ReadonlyArray<{ first_seen_at: string }>;
    if (!row) {
      return yield* Effect.die(
        new Error("upsertFindingFirstSeen: INSERT ... RETURNING produced no row"),
      );
    }
    return new Date(row.first_seen_at);
  });
