import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import * as schema from "@cloudable/schema";
import { orgs, people, settingValues } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { MachineService } from "./MachineService";
import { DEFAULT_REGION, DEFAULT_REGION_KEY, resolveOrgDefaultRegion } from "./region-policy";

// Real Postgres, not a fake — same convention/skip-guard as
// `../config/config.test.ts`: `bun test`/`test:unit` must stay green with no
// DB running. See that file's header comment for the full rationale.
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

describe.skipIf(!postgresReachable)("MachineService (requires Postgres at DATABASE_URL)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<MachineService>;

  beforeAll(async () => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: "../../packages/schema/migrations" });

    const dbLayer = Layer.succeed(Db, db);
    TestLayer = MachineService.Default.pipe(
      Layer.provide(Layer.mergeAll(dbLayer, Layer.provide(EventBus.Default, dbLayer))),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, MachineService>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  /** `machines.owner_person_id` has a real FK to `people.id`. */
  async function seedPerson(orgId: string) {
    const [person] = await db
      .insert(people)
      .values({ orgId, email: `person-${crypto.randomUUID()}@example.com`, role: "member" })
      .returning();
    if (!person) throw new Error("seed failed");
    return person;
  }

  test("create with no region falls back to DEFAULT_REGION when the org hasn't configured one", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "db-prod-01",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.region).toBe(DEFAULT_REGION);

    const resolved = await Effect.runPromise(resolveOrgDefaultRegion(db, org.id));
    expect(resolved).toEqual({ value: DEFAULT_REGION, source: "default" });
  });

  test("create with no region resolves the org's configured default, with source: org", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);

    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: org.id,
      key: DEFAULT_REGION_KEY,
      value: "westeurope",
      source: "org",
    });

    // Resolution itself carries the right `source` — this is the
    // `resolveSetting()` contract docs/inheritance.md describes: which
    // scope's row won, not just the raw value.
    const resolved = await Effect.runPromise(resolveOrgDefaultRegion(db, org.id));
    expect(resolved).toEqual({ value: "westeurope", source: "org" });

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "db-prod-02",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    // The new machine's stored region matches what the org resolved to —
    // resolved at creation time, not copied from a client-side prefill.
    expect(machine.region).toBe("westeurope");
  });

  test("create honors an explicit region over the org default", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);

    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: org.id,
      key: DEFAULT_REGION_KEY,
      value: "westeurope",
      source: "org",
    });

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "db-prod-03",
          region: "northeurope",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.region).toBe("northeurope");
  });

  test("two orgs configuring different defaults each get their own — no cross-org leakage", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const ownerA = await seedPerson(orgA.id);
    const ownerB = await seedPerson(orgB.id);

    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: orgA.id,
      key: DEFAULT_REGION_KEY,
      value: "westeurope",
      source: "org",
    });
    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: orgB.id,
      key: DEFAULT_REGION_KEY,
      value: "japaneast",
      source: "org",
    });

    const machineA = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: orgA.id,
          name: "a-1",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: ownerA.id,
        });
      }),
    );
    const machineB = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: orgB.id,
          name: "b-1",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: ownerB.id,
        });
      }),
    );

    expect(machineA.region).toBe("westeurope");
    expect(machineB.region).toBe("japaneast");
  });
});
