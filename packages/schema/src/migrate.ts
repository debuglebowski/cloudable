import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// A dedicated single-connection client for running migrations — separate
// from any pooled client the app uses at runtime.
const migrationClient = postgres(databaseUrl, { max: 1 });
const db = drizzle(migrationClient);

await migrate(db, { migrationsFolder: "./migrations" });
await migrationClient.end();

console.log("Migrations applied.");
process.exit(0);
