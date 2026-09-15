import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { machines, orgs } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { updateOrgPackages } from "../organisation/packages";
import { MachineService } from "./MachineService";
import { queryManifestHistory } from "./manifest-history";

// Same convention as `domain/organisation/packages.test.ts`: the shared
// docker-compose Postgres, every test scoped to a fresh random org.
describe("manifest history", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<MachineService | Db | EventBus>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    const eventBusLayer = EventBus.Default.pipe(Layer.provide(dbLayer));
    TestLayer = Layer.mergeAll(
      eventBusLayer,
      MachineService.Default.pipe(Layer.provide(FakeProvisioningServiceLive)),
      dbLayer,
    ).pipe(Layer.provide(dbLayer));
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, MachineService | Db | EventBus>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  async function seedMachine(orgId: string, name: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name,
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  const history = (orgId: string, machineId: string) =>
    Effect.runPromise(queryManifestHistory(db, { orgId, machineId }));

  test("records an add, a version change and an exclusion, newest first, with both values", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id, "m1");

    await run(
      Effect.gen(function* () {
        const service = yield* MachineService;
        yield* service.updatePackages({
          machineId: machine.id,
          orgId: org.id,
          upserts: [{ packageName: "ripgrep" }],
          actorPersonId: null,
        });
        yield* service.updatePackages({
          machineId: machine.id,
          orgId: org.id,
          upserts: [{ packageName: "ripgrep", versionPin: "14" }],
          actorPersonId: null,
        });
        yield* service.updatePackages({
          machineId: machine.id,
          orgId: org.id,
          upserts: [{ packageName: "ripgrep", excluded: true }],
          actorPersonId: null,
        });
      }),
    );

    const page = await history(org.id, machine.id);

    expect(page.items.map((entry) => entry.packageName)).toEqual(["ripgrep", "ripgrep", "ripgrep"]);
    expect(page.items.every((entry) => entry.scope === "machine")).toBe(true);
    // Newest first, so the exclusion leads.
    expect(page.items[0]?.current).toEqual({ versionPin: "14", pinned: false, excluded: true });
    expect(page.items[1]?.previous).toEqual({ versionPin: null, pinned: false, excluded: false });
    expect(page.items[1]?.current).toEqual({ versionPin: "14", pinned: false, excluded: false });
    // An add reads as "had nothing before".
    expect(page.items[2]?.previous).toBeNull();
  });

  test("includes org-scope edits, which change what this machine resolves to", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id, "m1");

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "docker", versionPin: "24", pinned: false }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );

    const page = await history(org.id, machine.id);

    // `org.setting_changed` carries no machineId, so without this it could
    // never appear on any machine's page at all.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.scope).toBe("org");
    expect(page.items[0]?.packageName).toBe("docker");
  });

  test("never shows another machine's edits", async () => {
    const org = await seedOrg();
    const mine = await seedMachine(org.id, "mine");
    const theirs = await seedMachine(org.id, "theirs");

    await run(
      Effect.gen(function* () {
        const service = yield* MachineService;
        yield* service.updatePackages({
          machineId: theirs.id,
          orgId: org.id,
          upserts: [{ packageName: "vim" }],
          actorPersonId: null,
        });
      }),
    );

    expect((await history(org.id, mine.id)).items).toHaveLength(0);
    expect((await history(org.id, theirs.id)).items).toHaveLength(1);
  });

  test("a machine in another org reads as empty rather than leaking that it exists", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const machine = await seedMachine(org.id, "m1");

    await run(
      Effect.gen(function* () {
        const service = yield* MachineService;
        yield* service.updatePackages({
          machineId: machine.id,
          orgId: org.id,
          upserts: [{ packageName: "vim" }],
          actorPersonId: null,
        });
      }),
    );

    expect((await history(other.id, machine.id)).items).toHaveLength(0);
  });

  test("a non-package setting change is not manifest history", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id, "m1");

    await run(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.publish([
          {
            id: "placeholder",
            type: "machine.setting_changed",
            occurredAt: new Date(),
            recordedAt: new Date(),
            orgId: org.id,
            actorType: "person",
            actorId: "person-1",
            machineId: machine.id,
            correlationId: crypto.randomUUID(),
            schemaVersion: 1,
            payload: { key: "logging_tier", previous: 2, current: 3, overridesLevel: "org" },
          },
        ]);
      }),
    );

    expect((await history(org.id, machine.id)).items).toHaveLength(0);
  });
});
