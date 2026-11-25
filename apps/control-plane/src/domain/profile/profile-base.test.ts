import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, integrations, machines, orgs, people } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { noUndeclaredSoftwareCheck } from "../../compliance/checks/no-undeclared-software";
import { Db } from "../../db/layer";
import { LOGGING_TIER_KEY, getEffectiveLoggingTier } from "../../logging/settings";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { isDbReachable } from "../../testing/db-reachable";
import { TunnelServer } from "../../tunnel/server";
import { TunnelSignal } from "../../tunnel/signal";
import { applySettingChange } from "../config/apply-setting-change";
import { MachineService } from "../machine/MachineService";
import { updateOrgPackages } from "../organisation/packages";
import {
  archiveProfile,
  createProfile,
  getProfile,
  setBaseProfile,
  updateProfile,
} from "./ProfileService";

// A profile that extends a base: org → base → profile → machine. Runs against the
// docker-compose Postgres (already migrated). Every test scopes its rows by a fresh org.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const reachable = await isDbReachable(DATABASE_URL);

type Env = Db | EventBus | TunnelServer | MachineService;

describe.skipIf(!reachable)("base profiles (requires Postgres at DATABASE_URL)", () => {
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

  const machineOn = (orgId: string, ownerPersonId: string, profileId: string) =>
    run(
      Effect.flatMap(MachineService, (svc) =>
        svc.create({
          orgId,
          ownerPersonId,
          actorPersonId: ownerPersonId,
          profileId,
          provider: "fake",
          sizeSku: "small",
          image: "ubuntu-24.04",
        }),
      ),
    );

  const setTier = (
    orgId: string,
    scopeType: "profile" | "machine",
    scopeId: string,
    value: 1 | 2,
    locked?: boolean,
  ) =>
    applySettingChange({
      orgId,
      scopeType,
      scopeId,
      key: LOGGING_TIER_KEY,
      value,
      ...(locked !== undefined ? { locked } : {}),
      actorType: "person",
      actorId: "test-admin",
      correlationId: crypto.randomUUID(),
    });

  test("a setting resolves org → base → profile → machine", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const base = await newProfile(org.id);
    const child = await newProfile(org.id, { baseProfileId: base.id });
    expect(child).toMatchObject({ baseProfileId: base.id, baseProfileName: base.name });
    const machine = await machineOn(org.id, owner.id, child.id);

    await run(setTier(org.id, "profile", base.id, 2));
    const fromBase = await run(
      getEffectiveLoggingTier(db, { orgId: org.id, machineId: machine.id, profileId: child.id }),
    );
    expect(fromBase).toEqual({ tier: 2, source: "profile" });

    // The child's own value wins over its base's.
    await run(setTier(org.id, "profile", child.id, 1));
    const fromChild = await run(
      getEffectiveLoggingTier(db, { orgId: org.id, machineId: machine.id, profileId: child.id }),
    );
    expect(fromChild.tier).toBe(1);

    const detail = await run(getProfile(org.id, child.id));
    expect(detail.base?.settings).toEqual([{ key: LOGGING_TIER_KEY, value: 2, locked: false }]);
    const baseView = await run(getProfile(org.id, base.id));
    expect(baseView.extendedBy).toBe(1);
  });

  test("a base lock blocks the profile and its machines from overriding it", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const base = await newProfile(org.id);
    const child = await newProfile(org.id, { baseProfileId: base.id });
    const machine = await machineOn(org.id, owner.id, child.id);
    await run(setTier(org.id, "profile", base.id, 2, true));

    const onChild = await fail(setTier(org.id, "profile", child.id, 1));
    expect(onChild).toMatchObject({
      _tag: "LockedSettingError",
      lockedAtScopeType: "profile",
      lockedAtScopeId: base.id,
    });
    const onMachine = await fail(setTier(org.id, "machine", machine.id, 1));
    expect(onMachine).toMatchObject({ _tag: "LockedSettingError", lockedAtScopeId: base.id });
  });

  test("a base's packages reach machines on the profile, and its locks bind both", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const base = await newProfile(org.id);
    const child = await newProfile(org.id, { baseProfileId: base.id });
    await run(
      updateOrgPackages({
        orgId: org.id,
        profileId: base.id,
        upserts: [{ packageName: "jq", locked: true }, { packageName: "htop" }],
        actor,
      }),
    );
    await run(
      updateOrgPackages({
        orgId: org.id,
        profileId: child.id,
        upserts: [{ packageName: "htop", versionPin: "3.3.0" }],
        actor,
      }),
    );
    const machine = await machineOn(org.id, owner.id, child.id);

    const desired = await run(
      Effect.flatMap(MachineService, (svc) => svc.desiredStateFor(machine.id, org.id)),
    );
    expect([...desired.allowedPackages].sort()).toEqual(["htop", "jq"]);

    const view = await run(
      Effect.flatMap(MachineService, (svc) => svc.packagesView(machine.id, org.id)),
    );
    const byName = new Map(view.items.map((row) => [row.packageName, row]));
    expect(byName.get("jq")).toMatchObject({ source: "profile", sourceProfileId: base.id });
    expect(byName.get("htop")).toMatchObject({
      source: "profile",
      sourceProfileId: child.id,
      versionPin: "3.3.0",
    });

    const onChild = await fail(
      updateOrgPackages({
        orgId: org.id,
        profileId: child.id,
        upserts: [{ packageName: "jq", versionPin: "1.6" }],
        actor,
      }),
    );
    expect(onChild).toMatchObject({ _tag: "PackageLockConflictError" });
    expect(JSON.stringify(onChild)).toContain(base.id);
    const onMachine = await fail(
      Effect.flatMap(MachineService, (svc) =>
        svc.updatePackages({
          machineId: machine.id,
          orgId: org.id,
          upserts: [{ packageName: "jq", excluded: true }],
        }),
      ),
    );
    expect(onMachine).toMatchObject({ _tag: "PackageLockConflictError" });
  });

  test("the compliance check counts a base's packages as declared", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const base = await newProfile(org.id);
    const child = await newProfile(org.id, { baseProfileId: base.id });
    await run(
      updateOrgPackages({
        orgId: org.id,
        profileId: base.id,
        upserts: [{ packageName: "jq" }],
        actor,
      }),
    );
    const machine = await machineOn(org.id, owner.id, child.id);
    await db
      .update(machines)
      .set({ installedPackages: ["jq", "nmap"], baselinePackages: [] })
      .where(eq(machines.id, machine.id));

    const findings = await run(noUndeclaredSoftwareCheck.evaluate({ orgId: org.id }));
    expect(findings.map((f) => f.detail)).toEqual([{ undeclaredPackages: ["nmap"] }]);
  });

  test("creation fields: the profile's own value wins, unless the base locks it", async () => {
    const org = await seedOrg();
    const owner = await seedPerson(org.id);
    const base = await newProfile(org.id, {
      provider: "fake",
      sizeSku: "small",
      sizeLocked: true,
      image: "ubuntu-22.04",
    });
    const child = await newProfile(org.id, { baseProfileId: base.id, image: "ubuntu-24.04" });
    expect(child.creation).toMatchObject({
      provider: { value: "fake", locked: false, fromProfileId: base.id },
      sizeSku: { value: "small", locked: true, fromProfileId: base.id },
      image: { value: "ubuntu-24.04", locked: false, fromProfileId: child.id },
    });

    // The base locks the size: the child cannot set another, nor can a machine on it.
    const childSize = await fail(
      updateProfile({ orgId: org.id, profileId: child.id, sizeSku: "large", actor }),
    );
    expect(childSize).toMatchObject({ code: "invalid_profile_field" });
    const largeMachine = await fail(
      Effect.flatMap(MachineService, (svc) =>
        svc.create({
          orgId: org.id,
          ownerPersonId: owner.id,
          actorPersonId: owner.id,
          profileId: child.id,
          sizeSku: "large",
        }),
      ),
    );
    expect(JSON.stringify(largeMachine)).toContain("locks the size");

    // Unset fields come from the base, set ones from the child.
    const machine = await run(
      Effect.flatMap(MachineService, (svc) =>
        svc.create({
          orgId: org.id,
          ownerPersonId: owner.id,
          actorPersonId: owner.id,
          profileId: child.id,
        }),
      ),
    );
    expect(machine).toMatchObject({ provider: "fake", sizeSku: "small", image: "ubuntu-24.04" });

    // The base cannot lock the image now: the child's machine has its own.
    const lockImage = await fail(
      updateProfile({ orgId: org.id, profileId: base.id, imageLocked: true, actor }),
    );
    expect(lockImage).toMatchObject({ code: "profile_in_use" });
  });

  test("one level only, and a profile cannot extend itself", async () => {
    const org = await seedOrg();
    const base = await newProfile(org.id);
    const child = await newProfile(org.id, { baseProfileId: base.id });
    const other = await newProfile(org.id);

    const grandchild = await fail(
      createProfile({ orgId: org.id, name: "gc", baseProfileId: child.id, actor }),
    );
    expect(grandchild).toMatchObject({ code: "invalid_base_profile" });
    const onto = await fail(
      setBaseProfile({ orgId: org.id, profileId: other.id, baseProfileId: child.id, actor }),
    );
    expect(onto).toMatchObject({ code: "invalid_base_profile" });
    const baseGetsBase = await fail(
      setBaseProfile({ orgId: org.id, profileId: base.id, baseProfileId: other.id, actor }),
    );
    expect(baseGetsBase).toMatchObject({ code: "invalid_base_profile" });
    const self = await fail(
      setBaseProfile({ orgId: org.id, profileId: other.id, baseProfileId: other.id, actor }),
    );
    expect(self).toMatchObject({ code: "invalid_base_profile" });

    const otherOrg = await seedOrg();
    const foreign = await newProfile(otherOrg.id);
    const crossOrg = await fail(
      setBaseProfile({ orgId: org.id, profileId: other.id, baseProfileId: foreign.id, actor }),
    );
    expect(crossOrg).toMatchObject({ code: "invalid_base_profile" });
  });

  test("a base that others extend cannot be archived; changing the base is recorded", async () => {
    const org = await seedOrg();
    const base = await newProfile(org.id);
    const child = await newProfile(org.id, { baseProfileId: base.id });

    const refused = await fail(archiveProfile({ orgId: org.id, profileId: base.id, actor }));
    expect(refused).toMatchObject({ _tag: "ProfileEditError", code: "profile_is_base" });

    const cleared = await run(
      setBaseProfile({ orgId: org.id, profileId: child.id, baseProfileId: null, actor }),
    );
    expect(cleared.baseProfileId).toBeNull();
    const archived = await run(archiveProfile({ orgId: org.id, profileId: base.id, actor }));
    expect(archived.archivedAt).not.toBeNull();

    // An archived profile cannot become a base.
    const ontoArchived = await fail(
      setBaseProfile({ orgId: org.id, profileId: child.id, baseProfileId: base.id, actor }),
    );
    expect(ontoArchived).toMatchObject({ code: "invalid_base_profile" });

    const recorded = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "profile.base_changed")));
    expect(recorded.map((e) => e.payload)).toEqual([
      { profileId: child.id, previousBaseProfileId: base.id, baseProfileId: null },
    ]);
    const created = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "profile.created")));
    expect(created.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ profileId: child.id, baseProfileId: base.id }),
    );
  });

  test("extending a base is refused while the profile sets something the base locks", async () => {
    const org = await seedOrg();
    const base = await newProfile(org.id);
    const child = await newProfile(org.id);
    await run(setTier(org.id, "profile", base.id, 2, true));
    await run(setTier(org.id, "profile", child.id, 1));

    const refused = await fail(
      setBaseProfile({ orgId: org.id, profileId: child.id, baseProfileId: base.id, actor }),
    );
    expect(refused).toMatchObject({ code: "invalid_base_profile" });
    expect(JSON.stringify(refused)).toContain(LOGGING_TIER_KEY);

    // Clear the child's own value, and it may extend the base.
    await run(
      applySettingChange({
        orgId: org.id,
        scopeType: "profile",
        scopeId: child.id,
        key: LOGGING_TIER_KEY,
        value: null,
        clear: true,
        actorType: "person",
        actorId: "test-admin",
        correlationId: crypto.randomUUID(),
      }),
    );
    const extended = await run(
      setBaseProfile({ orgId: org.id, profileId: child.id, baseProfileId: base.id, actor }),
    );
    expect(extended.baseProfileId).toBe(base.id);
  });
});
