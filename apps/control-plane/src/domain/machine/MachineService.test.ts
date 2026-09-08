import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import type * as schema from "@cloudable/schema";
import {
  events,
  integrations,
  machines,
  orgs,
  people,
  providerCatalogEntries,
  settingValues,
} from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import {
  FAKE_CREATE_FAILURE_IMAGE,
  FakeProvisioningServiceLive,
} from "../../services/ProvisioningService.fake";
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
      await db.delete(integrations).where(inArray(integrations.orgId, createdOrgIds));
      await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
      await db.delete(people).where(inArray(people.orgId, createdOrgIds));
      await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    }
    // `providerCatalogEntries` is global reference data, not org-scoped —
    // same rows a real "Sync from Azure" would produce, so left in place
    // rather than cleaned up (no test asserts row counts against it).
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

  async function enableProvider(orgId: string, provider: "azure" | "docker" | "fake") {
    await db.insert(integrations).values({ orgId, kind: "cloud", provider, identifier: provider });
  }

  /** Seeds the global, non-org-scoped catalog directly — same shape a real
   * "Sync from Azure" would produce (see provider-catalog.ts's doc comment
   * on why there's no per-org allow-list anymore). */
  async function seedCatalogEntry(
    kind: "region" | "image" | "sku",
    code: string,
    fields: { architecture?: string } = {},
  ) {
    await db
      .insert(providerCatalogEntries)
      .values({ provider: "azure", kind, code, displayName: code, ...fields })
      .onConflictDoNothing();
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

  test("name omitted: generates a friendly, adjective-noun-hex4 default", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "fake");

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          provider: "fake",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  test("name blank: same as omitted — generates a default rather than storing an empty string", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "fake");

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "   ",
          provider: "fake",
          sizeSku: "Standard_D2s_v5",
          image: "ubuntu-24.04",
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  test("name omitted twice in the same org: two different generated names", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "fake");

    const createOne = () =>
      run(
        Effect.gen(function* () {
          const svc = yield* MachineService;
          return yield* svc.create({
            orgId: org.id,
            provider: "fake",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          });
        }),
      );

    const [first, second] = await Promise.all([createOne(), createOne()]);
    expect(first.name).not.toBe(second.name);
  });

  test("provisioning failure: machine lands in error state with the failure message on lastError, and a machine.provisioning_failed event is recorded", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "fake");

    const machine = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* svc.create({
          orgId: org.id,
          name: "db-prod-broken",
          provider: "fake",
          sizeSku: "Standard_D2s_v5",
          image: FAKE_CREATE_FAILURE_IMAGE,
          ownerPersonId: owner.id,
        });
      }),
    );

    expect(machine.state).toBe("error");
    expect(machine.lastError).toContain("simulated create failure");

    const machineEvents = await db.select().from(events).where(eq(events.machineId, machine.id));
    const failureEvent = machineEvents.find((e) => e.type === "machine.provisioning_failed");
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.payload).toEqual({ stage: "create", error: machine.lastError });
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

  test("provider azure: an unrecognized region is rejected", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    // Deliberately nothing seeded in providerCatalogEntries for this region.

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-04",
            provider: "azure",
            region: "westeurope-unrecognized-test-region",
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider azure: an unrecognized image is rejected", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    await seedCatalogEntry("region", "westeurope");
    await seedCatalogEntry("sku", "Standard_D2s_v5", { architecture: "x64" });

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-06",
            provider: "azure",
            region: "westeurope",
            sizeSku: "Standard_D2s_v5",
            image: "windows-2022",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider azure: an unrecognized size is rejected", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    await seedCatalogEntry("region", "westeurope");
    // Deliberately nothing seeded for this sku code.

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-07",
            provider: "azure",
            region: "westeurope",
            sizeSku: "Standard_Unrecognized_Sku_v9",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
  });

  test("provider azure: a size whose architecture doesn't match the image's requirement is rejected", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    await seedCatalogEntry("region", "westeurope");
    // ubuntu-24.04 requires x64 (UBUNTU_IMAGES) — seed an Arm64 size.
    await seedCatalogEntry("sku", "Standard_D2ps_v6_arm_test", { architecture: "Arm64" });

    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* MachineService;
        return yield* Effect.either(
          svc.create({
            orgId: org.id,
            name: "db-prod-08",
            provider: "azure",
            region: "westeurope",
            sizeSku: "Standard_D2ps_v6_arm_test",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      const message =
        "error" in outcome.left ? outcome.left.error.message : JSON.stringify(outcome.left);
      expect(message).toContain("not compatible");
    }
  });

  test("provider azure: a real, synced region and a compatible size/image are accepted", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    await seedCatalogEntry("region", "westeurope");
    await seedCatalogEntry("sku", "Standard_D2s_v5", { architecture: "x64" });

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

  test("provider azure: AZURE_MACHINES_LOCATION forces the region, overriding client input entirely", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    await enableProvider(org.id, "azure");
    await seedCatalogEntry("sku", "Standard_D2s_v5", { architecture: "x64" });

    const original = config.azureMachinesLocation;
    // `config` is a plain mutable object (see config.ts's own doc comment —
    // `readonly` is compile-time only), read directly inside
    // `MachineService.create` rather than injected, so this is the only way
    // to exercise the locked branch without a real deployment env var.
    (config as { azureMachinesLocation: string | null }).azureMachinesLocation = "northeurope";
    try {
      const machine = await run(
        Effect.gen(function* () {
          const svc = yield* MachineService;
          return yield* svc.create({
            orgId: org.id,
            name: "locked-region",
            provider: "azure",
            region: "westeurope", // never even looked up when locked — ignored either way
            sizeSku: "Standard_D2s_v5",
            image: "ubuntu-24.04",
            ownerPersonId: owner.id,
          });
        }),
      );

      expect(machine.region).toBe("northeurope");
    } finally {
      (config as { azureMachinesLocation: string | null }).azureMachinesLocation = original;
    }
  });
});
