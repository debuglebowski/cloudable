import * as crypto from "node:crypto";
import * as path from "node:path";
import * as schema from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATIONS = path.resolve(import.meta.dir, "../../../../packages/schema/migrations");

export interface IsolatedDb {
  readonly url: string;
  readonly db: PostgresJsDatabase<typeof schema>;
  /** Closes the connection and drops the database. */
  readonly drop: () => Promise<void>;
}

/**
 * A brand-new, fully migrated database on the same Postgres server as `baseUrl`, dropped by
 * `drop()`. For tests whose subject acts on every row in a table, which no shared database can
 * host: switching on roles from the identity provider ends every console session and revokes
 * every person's credentials, deployment-wide, by design. Against the shared dev database that
 * would sign out every other worktree's users.
 */
export async function createIsolatedDb(baseUrl: string): Promise<IsolatedDb> {
  const name = `cloudable_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 4, onnotice: () => {} });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    url: url.toString(),
    db,
    drop: async () => {
      await client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
