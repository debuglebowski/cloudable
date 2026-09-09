import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import postgres from "postgres";

// Real Postgres, not a fake — this tests the actual leader-election mechanism
// `startReconcileDaemon` relies on (`pg_advisory_lock`/`unlock`), not a
// reimplementation of it. A dedicated, test-only key (never `daemon.ts`'s real
// `RECONCILE_LEADER_LOCK_KEY`, which isn't exported) so this can never collide
// with a real daemon that happens to be running against the same dev database.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const TEST_LOCK_KEY = 108_552_741;

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

describe.skipIf(!postgresReachable)(
  "pg_advisory_lock leader election (requires Postgres at DATABASE_URL)",
  () => {
    const openConnections: ReturnType<typeof postgres>[] = [];

    afterAll(async () => {
      await Promise.all(openConnections.map((sql) => sql.end({ timeout: 1 })));
    });

    function connect() {
      const sql = postgres(databaseUrl, { max: 1 });
      openConnections.push(sql);
      return sql;
    }

    test("a second connection's acquire blocks until the first releases", async () => {
      const leader = connect();
      const challenger = connect();

      await leader`select pg_advisory_lock(${TEST_LOCK_KEY})`;

      let challengerAcquired = false;
      const challengerAcquire = challenger`select pg_advisory_lock(${TEST_LOCK_KEY})`.then(() => {
        challengerAcquired = true;
      });

      // Give the challenger's query a real chance to round-trip and block --
      // if the lock weren't exclusive, this would already be true.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(challengerAcquired).toBe(false);

      await leader`select pg_advisory_unlock(${TEST_LOCK_KEY})`;
      await challengerAcquire;
      expect(challengerAcquired).toBe(true);

      await challenger`select pg_advisory_unlock(${TEST_LOCK_KEY})`;
    });

    // Mirrors what actually happens when a leader replica dies or its connection
    // drops mid-process (`daemon.ts` never calls `pg_advisory_unlock` explicitly on
    // that path) -- Postgres must release the lock on its own once the session ends,
    // or a dead replica would permanently wedge the whole fleet with no reconciler.
    test("closing the holder's connection releases the lock automatically", async () => {
      const leader = connect();
      const challenger = connect();

      await leader`select pg_advisory_lock(${TEST_LOCK_KEY})`;

      let challengerAcquired = false;
      const challengerAcquire = challenger`select pg_advisory_lock(${TEST_LOCK_KEY})`.then(() => {
        challengerAcquired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(challengerAcquired).toBe(false);

      await leader.end();
      await challengerAcquire;
      expect(challengerAcquired).toBe(true);

      await challenger`select pg_advisory_unlock(${TEST_LOCK_KEY})`;
    });
  },
);
