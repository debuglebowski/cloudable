import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import type * as schema from "@cloudable/schema";
import { machines, orgs } from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { connectAndMigrate } from "../../test-support/db";
import { MachineDirectory } from "./MachineDirectory";

// Real Postgres, not a fake — `markVerified`'s promotion logic is a hand-written SQL
// `CASE` expression; only a real round trip can confirm it actually does what it says.
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
  "MachineDirectory.markVerified (requires Postgres at DATABASE_URL)",
  () => {
    let close: () => Promise<void>;
    let db: PostgresJsDatabase<typeof schema>;
    let TestLayer: Layer.Layer<MachineDirectory>;
    const createdOrgIds: string[] = [];

    beforeAll(async () => {
      const conn = await connectAndMigrate(databaseUrl);
      db = conn.db;
      close = conn.close;
      TestLayer = MachineDirectory.Default.pipe(Layer.provide(Layer.succeed(Db, db)));
    });

    afterAll(async () => {
      if (!close) return;
      if (createdOrgIds.length > 0) {
        await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
        await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
      }
      await close();
    });

    const run = <A>(effect: Effect.Effect<A, never, MachineDirectory>) =>
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
      fields: { state: "provisioning" | "running" | "error"; lastError?: string },
    ) {
      const [machine] = await db
        .insert(machines)
        .values({
          orgId,
          name: `m-${crypto.randomUUID()}`,
          provider: "azure",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          state: fields.state,
          lastError: fields.lastError ?? null,
        })
        .returning();
      if (!machine) throw new Error("seed failed");
      return machine;
    }

    test("a check-in on a 'provisioning' machine promotes it to 'running'", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id, { state: "provisioning" });

      await run(
        Effect.gen(function* () {
          const directory = yield* MachineDirectory;
          yield* directory.markVerified(machine.id, new Date());
        }),
      );

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.state).toBe("running");
      expect(row?.lastVerifiedAt).not.toBeNull();
    });

    // The self-healing case this exists for: a reconcile pass (or anything else)
    // left the row at "error", but the agent is demonstrably alive and well right
    // now — a real check-in is stronger proof than whatever produced that "error",
    // so it corrects it rather than leaving a stale error showing.
    test("a check-in on an 'error' machine self-heals it to 'running', clearing lastError", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id, {
        state: "error",
        lastError: 'provider reconcile reported state "error"',
      });

      await run(
        Effect.gen(function* () {
          const directory = yield* MachineDirectory;
          yield* directory.markVerified(machine.id, new Date());
        }),
      );

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.state).toBe("running");
      expect(row?.lastError).toBeNull();
    });

    test("a check-in on an already-'running' machine is a no-op for state", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id, { state: "running" });

      await run(
        Effect.gen(function* () {
          const directory = yield* MachineDirectory;
          yield* directory.markVerified(machine.id, new Date());
        }),
      );

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.state).toBe("running");
    });

    // Deliberate: an archived machine's agent shouldn't normally still be
    // attesting, but if one somehow does, a check-in must never revive its
    // displayed lifecycle state.
    test("a check-in never revives an archived machine's state", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id, { state: "running" });
      await db
        .update(machines)
        .set({ state: "archived_restorable" })
        .where(eq(machines.id, machine.id));

      await run(
        Effect.gen(function* () {
          const directory = yield* MachineDirectory;
          yield* directory.markVerified(machine.id, new Date());
        }),
      );

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.state).toBe("archived_restorable");
    });
  },
);
