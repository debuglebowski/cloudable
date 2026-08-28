import * as schema from "@cloudable/schema";
import { events, settingValues } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
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
}
