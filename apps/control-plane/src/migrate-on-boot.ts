import * as schema from "@cloudable/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "./config";

/** Fixed, arbitrary — distinct from bootstrap-default-admin.ts's
 * BOOTSTRAP_ADVISORY_LOCK_KEY (394_812_207) and test-support/db.ts's
 * MIGRATION_ADVISORY_LOCK_KEY (847_291_003), so none of the three ever
 * collide on the same Postgres server. */
const BOOT_MIGRATION_ADVISORY_LOCK_KEY = 615_930_744;

/**
 * Runs pending drizzle migrations once at control-plane startup, before
 * anything else touches the database (bootstrapDefaultAdmin,
 * seedCatalogDefaults, the HTTP server). A self-hosted deploy has no
 * separate migration step in its pipeline — the Terraform module provisions
 * an empty Postgres database and nothing else applies the schema to it, and
 * that database's own firewall (AllowAzureServices only) keeps it hard to
 * reach from anywhere but the container itself. This is what actually
 * initializes the schema on a fresh deploy, rather than relying on an
 * operator remembering to run `db:migrate` by hand against a production
 * server they usually can't even reach directly.
 *
 * Guarded by the same max:1-connection + advisory-lock pattern
 * `test-support/db.ts`'s `connectAndMigrate` uses, for the same reason:
 * `min_replicas`/`max_replicas` can be > 1, and drizzle's migrator has no
 * built-in lock against two processes both deciding "there's a pending
 * migration" at the same moment and racing on `CREATE TABLE`.
 *
 * Deliberately left to throw (not swallowed like `seedCatalogDefaults`'s
 * best-effort catalog seed) — the caller in `server.ts` treats a failure
 * here as fatal. A schema that doesn't match the code about to run against
 * it isn't safe to serve traffic from; a crash-looping, clearly-unhealthy
 * revision in Azure is a better failure mode than quietly answering every
 * request with "relation does not exist".
 */
export async function migrateOnBoot(): Promise<void> {
  const sql = postgres(config.databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });
  try {
    await sql`select pg_advisory_lock(${BOOT_MIGRATION_ADVISORY_LOCK_KEY})`;
    try {
      await migrate(db, { migrationsFolder: "../../packages/schema/migrations" });
    } finally {
      await sql`select pg_advisory_unlock(${BOOT_MIGRATION_ADVISORY_LOCK_KEY})`;
    }
    console.log("[migrate] schema up to date");
  } finally {
    await sql.end();
  }
}
