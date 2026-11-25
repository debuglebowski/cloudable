import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, integrations, machines, orgs, people, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { Db } from "../../db/layer";
import { LOGGING_TIER_KEY } from "../../logging/settings";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { isDbReachable } from "../../testing/db-reachable";
import { TunnelServer } from "../../tunnel/server";
import { TunnelSignal } from "../../tunnel/signal";
import { applySettingChange } from "../config/apply-setting-change";
import { MachineService } from "../machine/MachineService";
import { updateOrgPackages } from "../organisation/packages";
import { EVENTS_RETENTION_DAYS_KEY } from "../retention/policy";
import { archiveProfile, createProfile, getProfile, updateProfile } from "./ProfileService";

// Runs against the docker-compose Postgres (already migrated). Every test scopes its rows by a
// fresh random org.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const reachable = await isDbReachable(DATABASE_URL);

type Env = Db | EventBus | TunnelServer | MachineService;

describe.skipIf(!reachable)("profiles (requires Postgres at DATABASE_URL)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let layer: Layer.Layer<Env>;

  beforeAll(() => {
    sql = postgres(DATABASE_URL);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    const eventBusLayer = EventBus.Default.pipe(Layer.provide(dbLayer));
    const tunnelLayer = TunnelServer.Default.pipe(
      Layer.provide(Layer.mergeAll(dbLayer, eventBusLayer, TunnelSignal.Default)),
    );
    layer = Layer.mergeAll(
      dbLayer,
      eventBusLayer,
      tunnelLayer,
      MachineService.Default.pipe(
        Layer.provide(Layer.mergeAll(dbLayer, FakeProvisioningServiceLive)),
      ),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Env>) =>
    Effect.runPromise(Effect.provide(effect, layer));
  const fail = <A, E>(effect: Effect.Effect<A, E, Env>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), layer));

  const actor = { actorType: "person" as const, actorId: "test-admin" };

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    await db
      .insert(integrations)
      .values({ orgId: org.id, kind: "cloud", provider: "fake", identifier: "fake" });
    return org;
  }

  async function seedPerson(orgId: string) {
    const [person] = await db
      .insert(people)
      .values({ orgId, email: `p-${crypto.randomUUID()}@example.com`, role: "member" })
      .returning();
    if (!person) throw new Error("seed failed");
    return person;
  }

  const newProfile = (orgId: string, fields: Partial<Parameters<typeof createProfile>[0]> = {}) =>
    run(createProfile({ orgId, name: `p-${crypto.randomUUID()}`, actor, ...fields }));

  const createMachine = (
    orgId: string,
    ownerPersonId: string,
    fields: Partial<Parameters<MachineService["create"]>[0]> = {},
  ) =>
    Effect.flatMap(MachineService, (svc) =>
      svc.create({ orgId, ownerPersonId, actorPersonId: ownerPersonId, ...fields }),
    );

  test("creating a profile records profile.created with the fields it sets", async () => {
    const org = await seedOrg();
    const profile = await newProfile(org.id, {
      provider: "fake",
      sizeSku: "small",
      image: "ubuntu-24.04",
    });

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "profile.created")));
    expect(event?.payload).toMatchObject({
      profileId: profile.id,
      provider: "fake",
      size: "small",
      image: "ubuntu-24.04",
      region: null,
    });
  });

  test("a name is unique in the org, and a region needs a provider that has one", async () => {
    const org = await seedOrg();
    const first = await newProfile(org.id);
    const taken = await fail(createProfile({ orgId: org.id, name: first.name, actor }));
    expect(taken).toMatchObject({ _tag: "ProfileEditError", code: "profile_name_taken" });

    const noProvider = await fail(
      createProfile({ orgId: org.id, name: "x", region: "eastus", actor }),
    );
    expect(noProvider).toMatchObject({ code: "invalid_profile_field" });
    const fakeRegion = await fail(
      createProfile({ orgId: org.id, name: "y", provider: "fake", region: "eastus", actor }),
    );
    expect(fakeRegion).toMatchObject({ code: "invalid_profile_field" });
  });

  test("a machine created on a profile takes the fields it leaves out from the profile", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id, {
      provider: "fake",
      sizeSku: "small",
      image: "ubuntu-24.04",
    });

    const machine = await run(createMachine(org.id, owner.id, { profileId: profile.id }));
    expect(machine).toMatchObject({
      profileId: profile.id,
      provider: "fake",
      sizeSku: "small",
      image: "ubuntu-24.04",
    });
    const [created] = await db
      .select()
      .from(events)
      .where(and(eq(events.machineId, machine.id), eq(events.type, "machine.created")));
    expect(created?.payload).toMatchObject({ profileId: profile.id });
  });

  test("a machine cannot be created with a field that differs from its profile's", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id, { provider: "fake", sizeSku: "small" });

    const error = await fail(
      createMachine(org.id, owner.id, {
        profileId: profile.id,
        sizeSku: "large",
        image: "ubuntu-24.04",
      }),
    );
    expect(error._tag).toBe("InvalidMachineRequestError");
    expect(JSON.stringify(error)).toContain('sets size to \\"small\\"');
  });

  test("an archived profile cannot take a new machine, but its machines keep reading from it", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id, { provider: "fake" });
    await run(
      applySettingChange({
        orgId: org.id,
        scopeType: "profile",
        scopeId: profile.id,
        key: LOGGING_TIER_KEY,
        value: 2,
        actorType: "person",
        actorId: "test-admin",
        correlationId: crypto.randomUUID(),
      }),
    );
    const machine = await run(
      createMachine(org.id, owner.id, {
        profileId: profile.id,
        sizeSku: "s",
        image: "ubuntu-24.04",
      }),
    );
    await run(archiveProfile({ orgId: org.id, profileId: profile.id, actor }));

    const detail = await run(
      Effect.flatMap(MachineService, (svc) => svc.getById(machine.id, org.id)),
    );
    expect(detail.loggingTier).toEqual({ tier: 2, source: "profile" });

    const other = await seedPerson(org.id);
    const refused = await fail(
      createMachine(org.id, other.id, {
        profileId: profile.id,
        sizeSku: "s",
        image: "ubuntu-24.04",
      }),
    );
    expect(JSON.stringify(refused)).toContain("archived");
  });

  test("profile settings resolve between org and machine, and locks hold at each level", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id);
    const machine = await run(
      createMachine(org.id, owner.id, {
        profileId: profile.id,
        provider: "fake",
        sizeSku: "s",
        image: "ubuntu-24.04",
      }),
    );
    const set = (
      scopeType: "org" | "profile" | "machine",
      scopeId: string,
      value: unknown,
      locked?: boolean,
    ) =>
      applySettingChange({
        orgId: org.id,
        scopeType,
        scopeId,
        key: LOGGING_TIER_KEY,
        value,
        locked,
        actorType: "person",
        actorId: "test-admin",
        correlationId: crypto.randomUUID(),
      });
    const tier = () =>
      run(Effect.flatMap(MachineService, (svc) => svc.getById(machine.id, org.id))).then(
        (detail) => detail.loggingTier,
      );

    await run(set("org", org.id, 1));
    await run(set("profile", profile.id, 2));
    expect(await tier()).toEqual({ tier: 2, source: "profile" });

    // Unlocked: one machine may override it.
    await run(set("machine", machine.id, 1));
    expect(await tier()).toEqual({ tier: 1, source: "machine" });

    // Locked on the profile: a machine edit is refused.
    await run(set("profile", profile.id, 2, true));
    const machineRefused = await fail(set("machine", machine.id, 2));
    expect(machineRefused).toMatchObject({
      _tag: "LockedSettingError",
      lockedAtScopeType: "profile",
    });

    // Locked on the org: the profile cannot override it either.
    await run(set("org", org.id, 1, true));
    const profileRefused = await fail(set("profile", profile.id, 1));
    expect(profileRefused).toMatchObject({ _tag: "LockedSettingError", lockedAtScopeType: "org" });

    const [changed] = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "profile.setting_changed")));
    expect(changed?.payload).toMatchObject({ profileId: profile.id, key: LOGGING_TIER_KEY });
  });

  test("clearing a profile's value sends its machines back to the org's", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id, { provider: "fake" });
    const machine = await run(
      createMachine(org.id, owner.id, {
        profileId: profile.id,
        sizeSku: "s",
        image: "ubuntu-24.04",
      }),
    );
    const change = (
      scopeType: "org" | "profile",
      scopeId: string,
      value: unknown,
      clear?: boolean,
    ) =>
      applySettingChange({
        orgId: org.id,
        scopeType,
        scopeId,
        key: LOGGING_TIER_KEY,
        value,
        clear,
        actorType: "person",
        actorId: "test-admin",
        correlationId: crypto.randomUUID(),
      });
    await run(change("org", org.id, 1));
    await run(change("profile", profile.id, 2));
    const cleared = await run(change("profile", profile.id, null, true));
    expect(cleared).toMatchObject({ previous: 2, current: null });

    const detail = await run(
      Effect.flatMap(MachineService, (svc) => svc.getById(machine.id, org.id)),
    );
    expect(detail.loggingTier).toEqual({ tier: 1, source: "org" });
    // Clearing again finds nothing, and records nothing.
    const again = await run(change("profile", profile.id, null, true));
    expect(again.event).toBeUndefined();
    const changes = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "profile.setting_changed")));
    expect(changes).toHaveLength(2);

    const refused = await fail(change("org", org.id, null, true));
    expect(refused._tag).toBe("InvalidScopeError");
  });

  test("an org-wide setting cannot be set on a profile", async () => {
    const org = await seedOrg();
    const profile = await newProfile(org.id);
    const error = await fail(
      applySettingChange({
        orgId: org.id,
        scopeType: "profile",
        scopeId: profile.id,
        key: EVENTS_RETENTION_DAYS_KEY,
        value: 400,
        actorType: "person",
        actorId: "test-admin",
        correlationId: crypto.randomUUID(),
      }),
    );
    expect(error._tag).toBe("InvalidScopeError");
    const rows = await db
      .select()
      .from(settingValues)
      .where(and(eq(settingValues.scopeType, "profile"), eq(settingValues.scopeId, profile.id)));
    expect(rows).toEqual([]);
  });

  test("a profile's packages reach its machines, and an org lock blocks the profile", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id, { provider: "fake" });
    const machine = await run(
      createMachine(org.id, owner.id, {
        profileId: profile.id,
        sizeSku: "s",
        image: "ubuntu-24.04",
      }),
    );

    await run(
      updateOrgPackages({
        orgId: org.id,
        profileId: profile.id,
        upserts: [{ packageName: "jq" }],
        actor,
      }),
    );
    const detail = await run(
      Effect.flatMap(MachineService, (svc) => svc.getById(machine.id, org.id)),
    );
    expect(detail.manifest.find((entry) => entry.packageName === "jq")).toMatchObject({
      source: "profile",
      resolvedFromScopeId: profile.id,
    });
    const view = await run(getProfile(org.id, profile.id));
    expect(view.packages.map((entry) => entry.packageName)).toEqual(["jq"]);

    await run(
      updateOrgPackages({
        orgId: org.id,
        upserts: [{ packageName: "curl", versionPin: "8", locked: true }],
        actor,
      }),
    );
    const refused = await fail(
      updateOrgPackages({
        orgId: org.id,
        profileId: profile.id,
        upserts: [{ packageName: "curl" }],
        actor,
      }),
    );
    expect(refused._tag).toBe("PackageLockConflictError");

    const [changed] = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "profile.setting_changed")));
    expect(changed?.payload).toMatchObject({
      profileId: profile.id,
      key: "package:jq",
      current: { packageName: "jq", pinned: false },
    });
  });

  test("creation fields are fixed while a machine uses the profile", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const profile = await newProfile(org.id, { provider: "fake", sizeSku: "small" });

    // No machines yet: allowed.
    await run(updateProfile({ orgId: org.id, profileId: profile.id, sizeSku: "medium", actor }));
    await run(createMachine(org.id, owner.id, { profileId: profile.id, image: "ubuntu-24.04" }));

    const refused = await fail(
      updateProfile({ orgId: org.id, profileId: profile.id, sizeSku: "large", actor }),
    );
    expect(refused).toMatchObject({ _tag: "ProfileEditError", code: "profile_in_use" });

    // Name and description can still change.
    const renamed = await run(
      updateProfile({ orgId: org.id, profileId: profile.id, description: "data team", actor }),
    );
    expect(renamed.description).toBe("data team");
    expect(renamed.machineCount).toBe(1);
  });

  test("moving a machine is recorded, and refused when the profile's fields do not match", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const machine = await run(
      createMachine(org.id, owner.id, {
        provider: "fake",
        sizeSku: "small",
        image: "ubuntu-24.04",
      }),
    );
    const fits = await newProfile(org.id, { provider: "fake", sizeSku: "small" });
    const misfit = await newProfile(org.id, { provider: "fake", sizeSku: "large" });

    const moved = await run(
      Effect.flatMap(MachineService, (svc) =>
        svc.setProfile({
          machineId: machine.id,
          orgId: org.id,
          profileId: fits.id,
          actorPersonId: owner.id,
        }),
      ),
    );
    expect(moved.profileId).toBe(fits.id);
    expect(moved.desiredStateVersion).toBeGreaterThan(machine.desiredStateVersion);

    const refused = await fail(
      Effect.flatMap(MachineService, (svc) =>
        svc.setProfile({
          machineId: machine.id,
          orgId: org.id,
          profileId: misfit.id,
          actorPersonId: owner.id,
        }),
      ),
    );
    expect(refused._tag).toBe("InvalidMachineRequestError");

    const [assigned] = await db
      .select()
      .from(events)
      .where(and(eq(events.machineId, machine.id), eq(events.type, "machine.profile_assigned")));
    expect(assigned?.payload).toEqual({ profileId: fits.id, previousProfileId: null });

    const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(row?.profileId).toBe(fits.id);
  });
});
