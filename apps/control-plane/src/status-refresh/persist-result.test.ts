import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import type * as schema from "@cloudable/schema";
import { events, machines, orgs } from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../db/layer";
import { EventBus } from "../services/EventBus";
import { connectAndMigrate } from "../test-support/db";
import { persistRefreshResult } from "./persist-result";

// Real Postgres, not a fake — same convention as this app's other DB-backed
// suites. The whole point of this function is a hand-written SQL `CASE`
// expression (grace-period + conditional write) — a pure-function test with
// a fake DB couldn't catch a real SQL bug here, only a real Postgres round
// trip can.
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

describe.skipIf(!postgresReachable)(
  "persistRefreshResult (requires Postgres at DATABASE_URL)",
  () => {
    let close: () => Promise<void>;
    let db: PostgresJsDatabase<typeof schema>;
    let TestLayer: Layer.Layer<Db | EventBus>;
    const createdOrgIds: string[] = [];

    beforeAll(async () => {
      const conn = await connectAndMigrate(databaseUrl);
      db = conn.db;
      close = conn.close;
      const dbLayer = Layer.succeed(Db, db);
      TestLayer = Layer.mergeAll(dbLayer, Layer.provide(EventBus.Default, dbLayer));
    });

    afterAll(async () => {
      if (!close) return;
      if (createdOrgIds.length > 0) {
        await db.delete(events).where(inArray(events.orgId, createdOrgIds));
        await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
        await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
      }
      await close();
    });

    const run = <A>(effect: Effect.Effect<A, never, Db | EventBus>) =>
      Effect.runPromise(Effect.provide(effect, TestLayer));

    async function seedOrg() {
      const [org] = await db
        .insert(orgs)
        .values({ name: `org-${crypto.randomUUID()}` })
        .returning();
      if (!org) throw new Error("seed failed");
      createdOrgIds.push(org.id);
      return org;
    }

    async function seedMachine(
      orgId: string,
      fields: { state?: "provisioning" | "running" | "error"; createdAt?: Date } = {},
    ) {
      const [machine] = await db
        .insert(machines)
        .values({
          orgId,
          name: `m-${crypto.randomUUID()}`,
          provider: "azure",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          state: fields.state ?? "provisioning",
          createdAt: fields.createdAt ?? new Date(),
        })
        .returning();
      if (!machine) throw new Error("seed failed");
      return machine;
    }

    test("in_sync result: writes the observed running state", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id, { state: "provisioning" });

      await run(
        persistRefreshResult({
          machineId: machine.id,
          action: {
            kind: "observed",
            status: { machineId: machine.id, state: "running", externalId: "ext-1" },
          },
        }),
      );

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.state).toBe("running");
      expect(row?.lastError).toBeNull();
      expect(row?.externalResourceId).toBe("ext-1");
    });

    test("already_archived result: only externalResourceId is touched, state is left alone", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id, { state: "running" });
      // Simulate the row already being archived at the DB level (a value
      // MachineStatus's own narrower "archived" state can't distinguish) --
      // persistRefreshResult must not clobber it with a generic value.
      await db
        .update(machines)
        .set({ state: "archived_restorable" })
        .where(eq(machines.id, machine.id));

      await run(
        persistRefreshResult({
          machineId: machine.id,
          action: {
            kind: "already_archived",
            status: { machineId: machine.id, state: "archived", externalId: null },
          },
        }),
      );

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.state).toBe("archived_restorable");
      expect(row?.externalResourceId).toBeNull();
    });
  },
);
