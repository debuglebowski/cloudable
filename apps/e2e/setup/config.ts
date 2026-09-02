/**
 * Same "sane dev defaults, real env wins" shape as
 * `apps/control-plane/src/config.ts` — lets `bun run test:e2e` work with
 * zero setup against a freshly cloned repo (docker-compose's default
 * Postgres port, the ports `dev:control-plane`/`dev:console` bind to),
 * while still honoring a real `.env` (loaded by the root `test:e2e` script
 * via `bun --env-file`) for anything non-default.
 */
export interface E2eConfig {
  readonly databaseUrl: string;
  readonly controlPlaneUrl: string;
  readonly consoleUrl: string;
}

export const e2eConfig: E2eConfig = {
  databaseUrl:
    process.env["DATABASE_URL"] ?? "postgres://cloudable:cloudable@localhost:5442/cloudable",
  controlPlaneUrl: `http://localhost:${process.env["PORT"] ?? 4780}`,
  consoleUrl: process.env["CONSOLE_ORIGIN"] ?? "http://localhost:5180",
};
