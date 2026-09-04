import * as schema from "@cloudable/schema";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { Wait } from "testcontainers";

/**
 * Spins up a throwaway Postgres container, migrates it with
 * `@cloudable/schema`'s migrations, and returns a ready Drizzle handle plus
 * a teardown function. Feature units' integration tests should import
 * `startTestDb` from here.
 *
 * `PostgreSqlContainer` defaults to `Wait.forAll([forHealthCheck(),
 * forListeningPorts()])`. `forListeningPorts()`'s internal-port half
 * (`InternalPortCheck`) verifies the port from inside the container via
 * `docker exec` (`cat /proc/net/tcp`, `nc`, `/dev/tcp`), reading the result
 * over Docker's multiplexed exec-attach stream — that stream never signals
 * end-of-stream under Bun, so the check hangs forever with no timeout
 * (confirmed directly: the container itself is healthy and accepting
 * connections in ~1s; `HostPortWaitStrategy.waitUntilReady` just never
 * resolves). The health check alone already proves Postgres is genuinely
 * up — this replaces the default wait strategy to skip the one that hangs,
 * not to skip readiness verification.
 */
export async function startTestDb() {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
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
