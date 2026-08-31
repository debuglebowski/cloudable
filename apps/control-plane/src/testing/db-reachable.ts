import net from "node:net";
import postgres from "postgres";

/**
 * Shared reachability check for colocated unit tests that need a real
 * Postgres (behaviour that a fake/in-memory store would paper over — see
 * e.g. `domain/config/config.test.ts`'s own header comment for why). Tests
 * using this must `describe.skipIf(!(await isDbReachable(...)))` themselves
 * — `bun test`/`test:unit` has to stay green with no DB running, and must
 * not fail against a stray/unmigrated Postgres that merely happens to be
 * listening on the conventional port (observed in this multi-agent sandbox,
 * where several concurrent worktrees' own Postgres containers can be
 * reachable on the same host at once).
 *
 * Deliberately does NOT use `@testcontainers/postgresql`: `.start()` hangs
 * indefinitely under Bun in this sandbox (upstream: oven-sh/bun#21342,
 * testcontainers-node#974) — see `test/testcontainers.ts`. Connects to the
 * same docker-compose Postgres the repo's own E2E verification uses
 * instead (`DATABASE_URL`, defaulting to the docker-compose value).
 *
 * To actually exercise a suite gated on this: `docker compose up -d` at the
 * repo root, `bun run db:migrate`, then run that file.
 */

function isPortReachable(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** `orgs` predates every migration — its presence is a good-enough proxy for "this
 * database has actually been migrated", without pinning the check to any one unit's
 * own newer column (unlike `config.test.ts`'s `desired_state_version` check, which is
 * specific to that unit). */
async function isMigrated(databaseUrl: string): Promise<boolean> {
  const probeSql = postgres(databaseUrl, { connect_timeout: 2, max: 1 });
  try {
    const rows = await probeSql`
      select 1 from information_schema.tables where table_name = 'orgs'
    `;
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await probeSql.end({ timeout: 1 });
  }
}

export async function isDbReachable(databaseUrl: string): Promise<boolean> {
  const { hostname, port } = new URL(databaseUrl);
  return (
    (await isPortReachable(hostname, Number(port) || 5432, 2000)) && (await isMigrated(databaseUrl))
  );
}
