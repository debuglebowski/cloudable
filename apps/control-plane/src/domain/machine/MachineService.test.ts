import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import type * as schema from "@cloudable/schema";
import {
  integrations,
  machines,
  orgCatalogSelections,
  orgs,
  people,
  settingValues,
} from "@cloudable/schema";
import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { connectAndMigrate } from "../../test-support/db";
import { MachineService } from "./MachineService";

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
  let close: () => Promise<void>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<MachineService>;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const conn = await connectAndMigrate(databaseUrl);
    db = conn.db;
    close = conn.close;

    const dbLayer = Layer.succeed(Db, db);
    TestLayer = MachineService.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          dbLayer,
          Layer.provide(EventBus.Default, dbLayer),
          FakeProvisioningServiceLive,
        ),
      ),
    );
  });

  afterAll(async () => {
    // `close` (and `db`) are only ever assigned once `connectAndMigrate` in
    // `beforeAll` actually succeeds — if it threw (e.g. a real migration
    // failure, possibly from a concurrent worktree's own unrelated run),
    // both stay unset, and running any of this would just throw a second,
    // more confusing error on top of the real one.
    if (!close) return;
    if (createdOrgIds.length > 0) {
      await db.delete(settingValues).where(inArray(settingValues.scopeId, createdOrgIds));
      await db
        .delete(orgCatalogSelections)
        .where(inArray(orgCatalogSelections.orgId, createdOrgIds));
      await db.delete(integrations).where(inArray(integrations.orgId, createdOrgIds));
      await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
      await db.delete(people).where(inArray(people.orgId, createdOrgIds));
      await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    }
    await close();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, MachineService>) =>
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

  /** `machines.owner_person_id` has a real FK to `people.id`. */
  async function seedPerson(orgId: string) {
    const [person] = await db
      .insert(people)
      .values({ orgId, email: `person-${crypto.randomUUID()}@example.com`, role: "member" })
      .returning();
    if (!person) throw new Error("seed failed");
    return person;
  }

  async function enableCatalogEntry(orgId: string, kind: "region" | "image", code: string) {
    await db.insert(orgCatalogSelections).values({ orgId, provider: "azure", kind, code });
  }

  async function enableProvider(orgId: string, provider: "azure" | "docker" | "fake") {
    await db.insert(integrations).values({ orgId, kind: "cloud", provider, identifier: provider });
  }

  test("provider not enabled for the org is rejected", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-00",
            provider: "fake",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider fake/docker: region is null, no catalog check", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "fake");

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "db-prod-01",
          provider: "fake",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.provider).toBe("fake");
    expect(machine.region).toBeNull();
  });

  test("provider fake/docker: a supplied region is rejected — the provider has none", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "docker");

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-02",
            provider: "docker",
            region: "eastus",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider azure: region required, rejected when omitted", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-03",
            provider: "azure",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider azure: a region/image not in the org's catalog is rejected", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-04",
            provider: "azure",
            region: "westeurope",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider azure: an enabled region/image is accepted", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    await enableCatalogEntry(org.id, "region", "westeurope");
    await enableCatalogEntry(org.id, "image", "ubuntu-24.04");

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "db-prod-05",
          provider: "azure",
          region: "westeurope",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.provider).toBe("azure");
    expect(machine.region).toBe("westeurope");
  });

  test("two orgs' catalogs don't leak into each other", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const ownerA = await seedPerson(orgA.id);
    const ownerB = await seedPerson(orgB.id);
    await enableProvider(orgA.id, "azure");
    await enableProvider(orgB.id, "azure");
    await enableCatalogEntry(orgA.id, "region", "westeurope");
    await enableCatalogEntry(orgA.id, "image", "ubuntu-24.04");
    await enableCatalogEntry(orgB.id, "region", "japaneast");
    await enableCatalogEntry(orgB.id, "image", "ubuntu-24.04");

    const machineA = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: orgA.id,
          name: "a-1",
          provider: "azure",
          region: "westeurope",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: ownerA.id,
        });
      }),
    );

    const outcomeB = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        // orgB never enabled "westeurope" — orgA's catalog must not leak in.
        return yield* Effect.either(
          svc.create({
            orgId: orgB.id,
            name: "b-1",
            provider: "azure",
            region: "westeurope",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: ownerB.id,
          }),
        );
      }),
    );

    expect(machineA.region).toBe("westeurope");
    expect(outcomeB._tag).toBe("Left");
  });
});
