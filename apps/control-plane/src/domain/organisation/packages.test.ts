import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, machinePackages, machines, orgs } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { MachineService } from "../machine/MachineService";
import { PackagePinConflictError } from "../machine/errors";
import { type OrgPackagesError, listOrgPackages, updateOrgPackages } from "./packages";

// Runs against the docker-compose Postgres (already migrated — see
// CLAUDE.md's E2E verification section), same convention as
// `services/ApprovalService.test.ts`: every test scopes its rows by a fresh
// random org, so this doesn't need an isolated container.
describe("org-scope package manifest write path", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<MachineService | Db | EventBus>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    const eventBusLayer = EventBus.Default.pipe(Layer.provide(dbLayer));
    // Mirrors `layers.ts`'s `buildAppLive`: `MachineService.Default` needs
    // `EventBus`/`Db` internally (its own `dependencies: [EventBus.Default]`
    // only satisfies that internally, it doesn't re-expose the `EventBus` tag),
    // so `eventBusLayer` is listed both as its own sibling (to expose `EventBus`
    // to `updateOrgPackages`/`listOrgPackages` below) and via the trailing
    // `Layer.provide(dbLayer)` that resolves every sibling's remaining `Db` need.
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

  const runFail = <A, E>(effect: Effect.Effect<A, E, MachineService | Db | EventBus>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), TestLayer));

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

  test("an org-scope package with no machine-level entry or override becomes the resolved default on a machine", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "docker", versionPin: "24", pinned: false }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );

    const detail = await run(
      Effect.gen(function* () {
        const service = yield* MachineService;
        return yield* service.getById(machine.id);
      }),
    );

    expect(detail.manifest).toEqual([
      {
        packageName: "docker",
        versionPin: "24",
        pinned: false,
        source: "org",
        resolvedFromScopeId: org.id,
      },
    ]);
  });

  test("a pinned org-scope entry rejects a conflicting machine-level override with PackagePinConflictError (422), not a silent no-op", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "docker", versionPin: "24", pinned: true }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );

    const error = await runFail(
      Effect.gen(function* () {
        const service = yield* MachineService;
        return yield* service.updatePackages({
          machineId: machine.id,
          upserts: [{ packageName: "docker", versionPin: "26" }],
        });
      }),
    );

    expect(error).toBeInstanceOf(PackagePinConflictError);
    expect((error as PackagePinConflictError).error.code).toBe("pinned_entry_conflict");
    expect((error as PackagePinConflictError).error.details.conflicts).toEqual([
      {
        packageName: "docker",
        pinnedAtScope: "org",
        pinnedAtScopeId: org.id,
        pinnedVersionPin: "24",
      },
    ]);

    // The edit failed atomically — no machine-level row was ever written.
    const machineRows = await db
      .select()
      .from(machinePackages)
      .where(
        and(eq(machinePackages.scopeType, "machine"), eq(machinePackages.scopeId, machine.id)),
      );
    expect(machineRows).toEqual([]);
  });

  test("upserting then removing an org package is reflected by listOrgPackages", async () => {
    const org = await seedOrg();

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "nodejs", versionPin: "20" }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );
    expect(await run(listOrgPackages(org.id))).toEqual([
      { packageName: "nodejs", versionPin: "20", pinned: false },
    ]);

    await run(
      updateOrgPackages({
        orgId: org.id,
        removals: ["nodejs"],
        actor: { actorType: "system", actorId: "test" },
      }),
    );
    expect(await run(listOrgPackages(org.id))).toEqual([]);
  });

  test("editing an org package emits a namespaced org.setting_changed event (level: org)", async () => {
    const org = await seedOrg();

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "curl", versionPin: null }],
        actor: { actorType: "system", actorId: "test-actor" },
      }),
    );

    const rows = await db.select().from(events).where(eq(events.orgId, org.id));
    expect(rows).toHaveLength(1);
    const [event] = rows;
    expect(event?.type).toBe("org.setting_changed");
    expect(event?.actorId).toBe("test-actor");
    expect(event?.payload).toMatchObject({
      key: "package:curl",
      previous: null,
      current: { packageName: "curl", versionPin: null, pinned: false },
      level: "org",
    });
  });

  test("an upsert that omits `pinned` preserves an existing entry's pin instead of silently stripping it", async () => {
    const org = await seedOrg();

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "docker", versionPin: "24", pinned: true }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );

    // Only `versionPin` is sent this time — `pinned` is omitted entirely.
    const result = await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "docker", versionPin: "26" }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );

    expect(result).toEqual([{ packageName: "docker", versionPin: "26", pinned: true }]);
    expect(await run(listOrgPackages(org.id))).toEqual([
      { packageName: "docker", versionPin: "26", pinned: true },
    ]);
  });

  test("listOrgPackages/updateOrgPackages reject a nonexistent org with org_not_found", async () => {
    const bogusOrgId = crypto.randomUUID();

    const listError = await runFail(listOrgPackages(bogusOrgId));
    expect((listError as OrgPackagesError).reason).toBe("org_not_found");

    const updateError = await runFail(
      updateOrgPackages({
        orgId: bogusOrgId,
        upserts: [{ packageName: "docker" }],
        actor: { actorType: "system", actorId: "test" },
      }),
    );
    expect((updateError as OrgPackagesError).reason).toBe("org_not_found");
  });
});
