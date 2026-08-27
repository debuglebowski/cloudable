import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` diffs the schema against migration snapshots and
// never opens a connection, so a local-dev fallback (matching
// docker-compose.yml / .env.example) keeps it runnable without a DATABASE_URL.
// `drizzle-kit migrate`/`push`, which do connect, need the real value set.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";

export default defineConfig({
  schema: "./src/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
