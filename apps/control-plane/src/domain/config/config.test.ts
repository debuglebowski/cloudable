import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import * as schema from "@cloudable/schema";
import { events, machines, orgs, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { Db } from "../../db/layer";
import { handleImportConfig, handlePatchSetting } from "../../http/handlers/config";
import { EventBus } from "../../services/EventBus";
import { applySettingChange } from "./apply-setting-change";
import { PinnedSettingError } from "./errors";
import { triggerReconcile } from "./trigger-reconcile";

// This suite runs against a real Postgres — the behaviour under test is the
// interaction between `settingValues`, `machines.desiredStateVersion`, and
// the append-only `events` table, which a fake/in-memory store would paper
// over. It deliberately does NOT use `@testcontainers/postgresql` (see
// `../../../test/testcontainers.ts`): `.start()` hangs indefinitely under
// Bun in this sandbox — a known upstream incompatibility
// (oven-sh/bun#21342, testcontainers-node#974), not something to debug
// here. Instead it connects to the same docker-compose Postgres the repo's
// own E2E verification uses (`DATABASE_URL`, defaulting to the
// docker-compose value), and skips itself entirely unless that instance is
// both reachable AND already migrated to include this unit's column —
// `bun test`/`test:unit` must stay green with no DB running, and must not
// fail against a stray/unmigrated Postgres that merely happens to be
// listening on the conventional port (observed in this multi-agent sandbox,
// where several concurrent worktrees' own Postgres containers can be
// reachable on the same host at once).
//
// To actually exercise this suite: `docker compose up -d` at the repo root,
// `bun run db:migrate`, then run this file.

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

async function hasDesiredStateVersionColumn(url: string): Promise<boolean> {
  const probeSql = postgres(url, { connect_timeout: 2, max: 1 });
  try {
    const rows = await probeSql`
      select 1 from information_schema.columns
      where table_name = 'machines' and column_name = 'desired_state_version'
    `;
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await probeSql.end({ timeout: 1 });
  }
}

const { hostname, port } = new URL(databaseUrl);
const postgresReachable =
  (await isReachable(hostname, Number(port) || 5432, 2000)) &&
  (await hasDesiredStateVersionColumn(databaseUrl));

describe.skipIf(!postgresReachable)("config (requires Postgres at DATABASE_URL)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let envLayer: Layer.Layer<Db | EventBus>;

  beforeAll(async () => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: "../../packages/schema/migrations" });

    const dbLayer = Layer.succeed(Db, db);
    envLayer = Layer.mergeAll(dbLayer, Layer.provide(EventBus.Default, dbLayer));
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus>) =>
    Effect.runPromise(Effect.provide(effect, envLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  async function seedMachine(orgId: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  describe("applySettingChange", () => {
    test("editing an org-scope setting is inert: no machine or reconcile side-effects", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);
      const correlationId = crypto.randomUUID();

      const result = await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "org",
          scopeId: org.id,
          key: "log_tier",
          value: 2,
          actorType: "person",
          actorId: "person-1",
          correlationId,
        }),
      );

      expect(result.previous).toBeNull();
      expect(result.current).toBe(2);

      const [row] = await db.select().from(settingValues).where(eq(settingValues.key, "log_tier"));
      expect(row?.value).toBe(2);

      // Inert: the machine in the same org is untouched.
      const [refetchedMachine] = await db
        .select()
        .from(machines)
        .where(eq(machines.id, machine.id));
      expect(refetchedMachine?.desiredStateVersion).toBe(0);

      // Exactly one event, org.setting_changed, with the right payload shape.
      const orgEvents = await db
        .select()
        .from(events)
        .where(eq(events.correlationId, correlationId));
      expect(orgEvents).toHaveLength(1);
      expect(orgEvents[0]?.type).toBe("org.setting_changed");
      expect(orgEvents[0]?.payload).toEqual({
        key: "log_tier",
        previous: null,
        current: 2,
        level: "org",
      });
    });

    test("editing a machine-scope setting is inert and reports what it overrides", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);
      const correlationId = crypto.randomUUID();

      const result = await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: "log_tier",
          value: 3,
          actorType: "person",
          actorId: "person-1",
          correlationId,
        }),
      );

      expect(result.previous).toBeNull();
      expect(result.current).toBe(3);

      const [refetchedMachine] = await db
        .select()
        .from(machines)
        .where(eq(machines.id, machine.id));
      expect(refetchedMachine?.desiredStateVersion).toBe(0);

      const machineEvents = await db
        .select()
        .from(events)
        .where(eq(events.correlationId, correlationId));
      expect(machineEvents).toHaveLength(1);
      expect(machineEvents[0]?.type).toBe("machine.setting_changed");
      expect(machineEvents[0]?.machineId).toBe(machine.id);
      expect(machineEvents[0]?.payload).toEqual({
        key: "log_tier",
        previous: null,
        current: 3,
        overridesLevel: "org",
      });
    });

    test("overriding a pinned org-level package manifest entry is rejected", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "org",
          scopeId: org.id,
          key: "packages",
          value: [{ package: "docker" }],
          pinned: true,
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const error = await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: "packages",
          value: [{ package: "docker", version: "24" }],
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }).pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(PinnedSettingError);
      expect(error).toMatchObject({
        key: "packages",
        pinnedAtScopeType: "org",
        pinnedAtScopeId: org.id,
      });

      // No machine-scope row was written.
      const machineRows = await db
        .select()
        .from(settingValues)
        .where(eq(settingValues.scopeType, "machine"));
      expect(machineRows.find((r) => r.key === "packages")).toBeUndefined();
    });

    test("the pinned flag is a machine-scope no-op — it's an org-scope-only concept", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: "log_tier",
          value: 1,
          pinned: true,
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const [row] = await db
        .select()
        .from(settingValues)
        .where(and(eq(settingValues.scopeType, "machine"), eq(settingValues.scopeId, machine.id)));
      expect(row?.pinned).toBe(false);
    });
  });

  describe("triggerReconcile", () => {
    test("is rejected without an explicit confirm:true, and does not bump the version", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);

      const errorWhenAbsent = await run(
        triggerReconcile({ orgId: org.id, machineId: machine.id, confirm: undefined }).pipe(
          Effect.flip,
        ),
      );
      const errorWhenFalse = await run(
        triggerReconcile({ orgId: org.id, machineId: machine.id, confirm: false }).pipe(
          Effect.flip,
        ),
      );

      expect(errorWhenAbsent._tag).toBe("ConfirmationRequiredError");
      expect(errorWhenFalse._tag).toBe("ConfirmationRequiredError");

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.desiredStateVersion).toBe(0);
    });

    test("bumps desiredStateVersion when confirmed, once per call", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);

      const first = await run(
        triggerReconcile({ orgId: org.id, machineId: machine.id, confirm: true }),
      );
      expect(first.desiredStateVersion).toBe(1);

      const second = await run(
        triggerReconcile({ orgId: org.id, machineId: machine.id, confirm: true }),
      );
      expect(second.desiredStateVersion).toBe(2);

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.desiredStateVersion).toBe(2);
    });

    test("is rejected as not-found when the machine belongs to a different org", async () => {
      const org = await seedOrg();
      const otherOrg = await seedOrg();
      const machine = await seedMachine(org.id);

      const error = await run(
        triggerReconcile({ orgId: otherOrg.id, machineId: machine.id, confirm: true }).pipe(
          Effect.flip,
        ),
      );
      expect(error._tag).toBe("MachineNotFoundError");

      const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
      expect(row?.desiredStateVersion).toBe(0);
    });
  });

  describe("PATCH and import parity", () => {
    test("handlePatchSetting and handleImportConfig produce byte-identical *.setting_changed payloads for an equivalent change", async () => {
      const org = await seedOrg();
      const machineA = await seedMachine(org.id);
      const machineB = await seedMachine(org.id);

      await run(
        handlePatchSetting({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machineA.id,
          key: "example_key",
          value: { foo: "bar" },
          actor: { type: "person", id: "person-1" },
        }),
      );

      await run(
        handleImportConfig({
          orgId: org.id,
          actor: { type: "system", id: "git-ci" },
          entries: [
            {
              scopeType: "machine",
              scopeId: machineB.id,
              key: "example_key",
              value: { foo: "bar" },
            },
          ],
        }),
      );

      const [eventA] = await db.select().from(events).where(eq(events.machineId, machineA.id));
      const [eventB] = await db.select().from(events).where(eq(events.machineId, machineB.id));

      expect(eventA?.type).toBe("machine.setting_changed");
      expect(eventB?.type).toBe("machine.setting_changed");
      // Same logical change, same resulting payload — both entry points call
      // the exact same `applySettingChange` function.
      expect(eventA?.payload).toEqual(eventB?.payload);
      expect(eventA?.payload).toEqual({
        key: "example_key",
        previous: null,
        current: { foo: "bar" },
        overridesLevel: "org",
      });
    });
  });
});
