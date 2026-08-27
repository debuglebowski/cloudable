import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@cloudable/schema";

/**
 * Spins up a throwaway Postgres container, migrates it with
 * `@cloudable/schema`'s migrations, and returns a ready Drizzle handle plus
 * a teardown function. Not exercised by this skeleton's own test run
 * (Docker/Testcontainers may or may not be available in every sandbox) —
 * this file just needs to compile. Feature units' integration tests should
 * import `startTestDb` from here.
 */
export async function startTestDb() {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const sql = postgres(container.getConnectionUri());
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "../../packages/schema/migrations" });
  return {
    db,
    stop: async () => {
      await sql.end();
      await container.stop();
    },
  };
}
