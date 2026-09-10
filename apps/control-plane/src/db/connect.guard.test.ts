import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the rule that every runtime Postgres client goes through
 * `openPostgres()` in `db/connect.ts`.
 *
 * This is not style policing. `reconcile/daemon.ts` built its own client with
 * `postgres(config.databaseUrl, ...)`, which was fine under password auth and
 * silently fatal under `DATABASE_AUTH_MODE=entra`: the connection string has
 * no password in that mode, so every attempt failed with "Password returned by
 * client is empty". The daemon logs a warning and retries forever, so nothing
 * crashed, nothing alerted, and reconciliation was simply dead in a real
 * deployment until someone read the logs.
 *
 * The failure mode is what makes this worth a test — a missed call site does
 * not break a build or a test run, it breaks one background loop in production.
 */
const SRC = join(import.meta.dir, "..");

/** Non-runtime code: manual integration checks and test helpers, which build their own clients against a local dev database on purpose. */
const ALLOWED = new Set([
  "db/connect.ts",
  "auth.integration-check.ts",
  "services/IdpSsoService.integration-check.ts",
  "services/reconcile-diff.integration.ts",
  "testing/db-reachable.ts",
  "test-support/db.ts",
]);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });

describe("postgres client construction", () => {
  it("only happens in db/connect.ts", () => {
    const offenders = walk(SRC)
      .map((file) => ({ file, rel: file.slice(SRC.length + 1) }))
      .filter(({ rel }) => !ALLOWED.has(rel) && !rel.includes(".test."))
      .filter(({ file }) => /^import postgres from "postgres";$/m.test(readFileSync(file, "utf8")));

    expect(offenders.map((o) => o.rel)).toEqual([]);
  });
});
