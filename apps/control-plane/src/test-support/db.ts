import * as schema from "@cloudable/schema";
import { events, machines, settingValues } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * A Drizzle handle against the local dev Postgres (docker-compose, port
 * 5442 — see repo root `docker-compose.yml`), already migrated. Used by
 * this unit's tests instead of `../../test/testcontainers.ts`'s throwaway
 * container: this dev machine runs several agents' worktrees against the
 * same Postgres concurrently, so every test using this helper scopes all
 * reads/writes to a freshly generated `orgId`/`machineId` (never asserts on
 * unscoped/global row counts) and cleans up its own rows afterward.
 */
export function connectTestDb(): {
  db: PostgresJsDatabase<typeof schema>;
  close: () => Promise<void>;
} {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
  const sql = postgres(databaseUrl);
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

export async function cleanupOrgRows(
  db: PostgresJsDatabase<typeof schema>,
  orgId: string,
): Promise<void> {
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(settingValues).where(eq(settingValues.scopeId, orgId));
  await db.delete(machines).where(eq(machines.orgId, orgId));
}

/** Fixed, arbitrary — must stay the same across every caller so concurrent
 * `bun test` processes (different worktrees on this shared box) actually
 * serialize on the same lock instead of each picking their own. */
const MIGRATION_ADVISORY_LOCK_KEY = 847_291_003;

/**
 * Same shape as `connectTestDb`, but also runs `migrate()` itself, guarded
 * by a Postgres advisory lock — for the couple of test files that can't
 * assume the shared dev DB is already migrated. The lock serializes
 * concurrent `migrate()` calls from separate `bun test` processes (this dev
 * box runs several agents' worktrees against the same Postgres at once);
 * drizzle's own migrator has no such lock, so two processes both deciding
 * "there's a pending migration" at the same moment can otherwise race on
 * `CREATE TABLE`.
 */
export async function connectAndMigrate(databaseUrl: string): Promise<{
  db: PostgresJsDatabase<typeof schema>;
  close: () => Promise<void>;
}> {
  // `max: 1` is load-bearing, not an optimization: `postgres()` defaults to a
  // connection *pool*, and `pg_advisory_lock`/`pg_advisory_unlock` are scoped
  // to whichever single backend session issued them. Against a pool, the
  // lock/unlock/migrate queries below could each land on a different pooled
  // connection, making the "lock" a no-op — this forces all of them onto the
  // one session that actually holds it.
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });
  await sql`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
  try {
    await migrate(db, { migrationsFolder: "../../packages/schema/migrations" });
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;
  }
  return { db, close: () => sql.end() };
}
