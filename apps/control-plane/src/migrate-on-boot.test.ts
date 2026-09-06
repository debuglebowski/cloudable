import { describe, expect, test } from "bun:test";
import net from "node:net";
import postgres from "postgres";
import { migrateOnBoot } from "./migrate-on-boot";

// Real Postgres, not a fake — same convention/skip-guard as
// `bootstrap-default-admin.test.ts`: `bun test`/`test:unit` must stay green
// with no DB running.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";

function isReachable(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
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

const { hostname, port } = new URL(databaseUrl);
const postgresReachable = await isReachable(hostname, Number(port) || 5432, 2000);

describe.skipIf(!postgresReachable)("migrateOnBoot (requires Postgres at DATABASE_URL)", () => {
  test("applies the schema and is safe to call again once already migrated", async () => {
    await migrateOnBoot();
    await migrateOnBoot(); // idempotent — every real boot after the first hits this path

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('auth_user', 'people', 'orgs')
      `;
      expect(rows.map((r) => r.table_name).sort()).toEqual(["auth_user", "orgs", "people"]);
    } finally {
      await sql.end();
    }
  });
});
