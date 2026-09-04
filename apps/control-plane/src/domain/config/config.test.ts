import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import type * as schema from "@cloudable/schema";
import { events, machines, orgs, sessions, settingValues } from "@cloudable/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { Db } from "../../db/layer";
import { handleImportConfig, handlePatchSetting } from "../../http/handlers/config";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { connectAndMigrate } from "../../test-support/db";
import { TunnelServer } from "../../tunnel/server";
import { TunnelSignal } from "../../tunnel/signal";
import { MachineService } from "../machine/MachineService";
import { ACCESS_METHODS_ENABLED_KEY } from "../machine/settings";
import { updateOrgSettings } from "../organisation/settings";
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
  let close: () => Promise<void>;
  let db: PostgresJsDatabase<typeof schema>;
  let envLayer: Layer.Layer<Db | EventBus | TunnelServer>;
  let machineLayer: Layer.Layer<MachineService>;
  const createdOrgIds: string[] = [];
  const createdMachineIds: string[] = [];

  beforeAll(async () => {
    const conn = await connectAndMigrate(databaseUrl);
    db = conn.db;
    close = conn.close;

    const dbLayer = Layer.succeed(Db, db);
    const eventBusLayer = EventBus.Default.pipe(Layer.provide(dbLayer));
    const tunnelSignalLayer = TunnelSignal.Default;
    const tunnelLayer = TunnelServer.Default.pipe(
      Layer.provide(Layer.mergeAll(dbLayer, eventBusLayer, tunnelSignalLayer)),
    );
    envLayer = Layer.mergeAll(dbLayer, eventBusLayer, tunnelLayer);
    machineLayer = Layer.provide(
      MachineService.Default,
      Layer.mergeAll(dbLayer, FakeProvisioningServiceLive),
    );
  });

  afterAll(async () => {
    // See the identical comment in `MachineService.test.ts`'s own `afterAll`
    // — `close`/`db` are unset if `connectAndMigrate` in `beforeAll` threw.
    if (!close) return;
    if (createdOrgIds.length > 0 || createdMachineIds.length > 0) {
      await db.delete(sessions).where(inArray(sessions.orgId, createdOrgIds));
      await db
        .delete(settingValues)
        .where(
          or(
            inArray(settingValues.scopeId, createdOrgIds),
            inArray(settingValues.scopeId, createdMachineIds),
          ),
        );
      await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
      await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    }
    await close();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | TunnelServer>) =>
    Effect.runPromise(Effect.provide(effect, envLayer));

  const runMachineService = <A, E>(effect: Effect.Effect<A, E, MachineService>) =>
    Effect.runPromise(Effect.provide(effect, machineLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    createdOrgIds.push(org.id);
    return org;
  }

  async function seedMachine(orgId: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        state: "running",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    createdMachineIds.push(machine.id);
    return machine;
  }

  /** An open (not-yet-ended) `sessions` row, as if a live web-terminal session were attached. */
  async function seedOpenSession(orgId: string, machineId: string) {
    const [session] = await db
      .insert(sessions)
      .values({
        orgId,
        machineId,
        personId: crypto.randomUUID(),
        method: "terminal",
        osUser: "ubuntu",
      })
      .returning();
    if (!session) throw new Error("seed failed");
    return session;
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

    // Disabling terminates live sessions — not merely refuses
    // new ones. This is the gap this test closes: `applySettingChange` (the one
    // shared write path behind both the PATCH endpoint and Git import) must
    // itself call `TunnelServer.terminateSessionsForMachine`, not leave it
    // wired to nothing but its own test.
    test("disabling web terminal at machine scope ends that machine's open sessions", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);
      const session = await seedOpenSession(org.id, machine.id);
      const correlationId = crypto.randomUUID();

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: ACCESS_METHODS_ENABLED_KEY,
          value: { webTerminal: false, ssh: true },
          actorType: "person",
          actorId: "person-1",
          correlationId,
        }),
      );

      const [refetchedSession] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(refetchedSession?.endedAt).not.toBeNull();

      const sessionEndedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.type, "access.session_ended"), eq(events.machineId, machine.id)));
      expect(sessionEndedEvents).toHaveLength(1);
    });

    test("re-enabling web terminal never terminates anything", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);
      const session = await seedOpenSession(org.id, machine.id);

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: ACCESS_METHODS_ENABLED_KEY,
          value: { webTerminal: true, ssh: true },
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const [refetchedSession] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(refetchedSession?.endedAt).toBeNull();
    });

    test("disabling web terminal at org scope ends sessions on every machine without its own override, but spares one that overrides it back on", async () => {
      const org = await seedOrg();
      const inheritingMachine = await seedMachine(org.id);
      const overriddenMachine = await seedMachine(org.id);

      // `overriddenMachine` explicitly keeps web terminal on, overriding
      // whatever the org is about to set — its own row always wins
      // resolution, so the org-level change below must not touch it.
      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: overriddenMachine.id,
          key: ACCESS_METHODS_ENABLED_KEY,
          value: { webTerminal: true, ssh: true },
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const inheritingSession = await seedOpenSession(org.id, inheritingMachine.id);
      const overriddenSession = await seedOpenSession(org.id, overriddenMachine.id);

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "org",
          scopeId: org.id,
          key: ACCESS_METHODS_ENABLED_KEY,
          value: { webTerminal: false, ssh: true },
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const [refetchedInheriting] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, inheritingSession.id));
      expect(refetchedInheriting?.endedAt).not.toBeNull();

      const [refetchedOverridden] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, overriddenSession.id));
      expect(refetchedOverridden?.endedAt).toBeNull();
    });

    test("re-saving an already-disabled access setting does not re-terminate", async () => {
      const org = await seedOrg();
      const machine = await seedMachine(org.id);

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: ACCESS_METHODS_ENABLED_KEY,
          value: { webTerminal: false, ssh: true },
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      // A session that starts only *after* the disable — as if minted through
      // some other, buggier path — must be untouched by a second, redundant
      // "disable" write; only a true enabled→disabled transition terminates.
      const session = await seedOpenSession(org.id, machine.id);

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machine.id,
          key: ACCESS_METHODS_ENABLED_KEY,
          value: { webTerminal: false, ssh: true },
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const [refetchedSession] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(refetchedSession?.endedAt).toBeNull();
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
      const currentUser = { orgId: org.id, personId: "person-1", email: "person-1@example.com" };

      await run(
        handlePatchSetting(
          {
            scopeType: "machine",
            scopeId: machineA.id,
            key: "example_key",
            value: { foo: "bar" },
          },
          currentUser,
        ),
      );

      await run(
        handleImportConfig(
          {
            entries: [
              {
                scopeType: "machine",
                scopeId: machineB.id,
                key: "example_key",
                value: { foo: "bar" },
              },
            ],
          },
          currentUser,
        ),
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

  describe("updateOrgSettings", () => {
    test("routes org-scoped writes through applySettingChange: same event a direct call would produce", async () => {
      const orgA = await seedOrg();
      const orgB = await seedOrg();

      await run(
        updateOrgSettings({
          orgId: orgA.id,
          loggingTier: 3,
          actor: { actorType: "person", actorId: "person-1" },
        }),
      );

      // The exact same call `updateOrgSettings` now makes internally,
      // issued directly against a second org.
      await run(
        applySettingChange({
          orgId: orgB.id,
          scopeType: "org",
          scopeId: orgB.id,
          key: "logging_tier",
          value: 3,
          actorType: "person",
          actorId: "person-1",
          correlationId: crypto.randomUUID(),
        }),
      );

      const [eventA] = await db.select().from(events).where(eq(events.orgId, orgA.id));
      const [eventB] = await db.select().from(events).where(eq(events.orgId, orgB.id));

      expect(eventA?.type).toBe("org.setting_changed");
      expect(eventA?.payload).toEqual(eventB?.payload);
      expect(eventA?.payload).toEqual({
        key: "logging_tier",
        previous: null,
        current: 3,
        level: "org",
      });
    });

    test("a PATCH touching multiple keys shares one correlationId across their events, same as one PATCH /config/settings call", async () => {
      const org = await seedOrg();

      await run(
        updateOrgSettings({
          orgId: org.id,
          loggingTier: 1,
          retentionDefaultDays: 90,
          actor: { actorType: "system", actorId: "system" },
        }),
      );

      const rows = await db.select().from(events).where(eq(events.orgId, org.id));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.correlationId)).size).toBe(1);
      expect(rows.every((r) => r.type === "org.setting_changed")).toBe(true);
    });

    test("rejects the whole PATCH before writing anything when one field fails validation, even if an earlier field would have succeeded", async () => {
      const org = await seedOrg();

      const error = await run(
        updateOrgSettings({
          orgId: org.id,
          approvalModes: { break_glass: "dual" },
          retentionDefaultDays: -5,
          actor: { actorType: "person", actorId: "person-1" },
        }).pipe(Effect.flip),
      );

      expect(error).toMatchObject({ reason: "retention_days_must_be_a_positive_integer" });

      // Nothing committed — not the settingValues row, and no event either.
      const [row] = await db
        .select()
        .from(settingValues)
        .where(
          and(
            eq(settingValues.scopeId, org.id),
            eq(settingValues.key, "approval_mode:break_glass"),
          ),
        );
      expect(row).toBeUndefined();
      const rows = await db.select().from(events).where(eq(events.orgId, org.id));
      expect(rows).toHaveLength(0);
    });

    test("previously-silent approval-mode and retention-days writes now emit org.setting_changed (the gap this unit closes)", async () => {
      const org = await seedOrg();

      await run(
        updateOrgSettings({
          orgId: org.id,
          approvalModes: { break_glass: "dual" },
          retentionDefaultDays: 45,
          actor: { actorType: "person", actorId: "person-1" },
        }),
      );

      const rows = await db.select().from(events).where(eq(events.orgId, org.id));
      const keys = rows.map((r) => (r.payload as { key: string }).key).sort();
      expect(keys).toEqual(["approval_mode:break_glass", "archive.retentionDays"]);
    });
  });

  describe("MachineService.updatePackages", () => {
    test("emits machine.setting_changed built from the exact same shape applySettingChange uses for a machine-scope change", async () => {
      const org = await seedOrg();
      const machineA = await seedMachine(org.id);
      const machineB = await seedMachine(org.id);

      // The real machine package-manifest write path (PATCH
      // /api/v1/machines/:id/packages) — package-manifest entries live in
      // their own `machinePackages` table, not `settingValues` (see
      // docs/inheritance.md: "packageName IS the setting key" but the
      // storage is scope-generic and set-shaped, deliberately not a row
      // inside settingValues), so this cannot literally call
      // `applySettingChange` without either corrupting that table's role
      // as the single source of truth for `resolveManifest`/reconcile/
      // compliance, or writing a second, drifting settingValues row nothing
      // reads. What IS shared, and asserted here, is the event: both this
      // and `applySettingChange`'s machine branch build their
      // `machine.setting_changed` event via the one `machineSettingChangedEvent`
      // helper (`domain/machine/events.ts`), so the audit trail shape can
      // never drift apart between the two.
      await runMachineService(
        Effect.gen(function* () {
          const machineService = yield* MachineService;
          yield* machineService.updatePackages({
            machineId: machineA.id,
            orgId: org.id,
            upserts: [{ packageName: "docker", versionPin: "24", pinned: false }],
            actorPersonId: null,
          });
        }),
      );

      await run(
        applySettingChange({
          orgId: org.id,
          scopeType: "machine",
          scopeId: machineB.id,
          key: "docker",
          value: { versionPin: "24", pinned: false },
          actorType: "system",
          actorId: "system",
          correlationId: crypto.randomUUID(),
        }),
      );

      const [eventA] = await db.select().from(events).where(eq(events.machineId, machineA.id));
      const [eventB] = await db.select().from(events).where(eq(events.machineId, machineB.id));

      expect(eventA?.type).toBe("machine.setting_changed");
      expect(eventB?.type).toBe("machine.setting_changed");
      // Same fields, same key/current value. `overridesLevel` differs by
      // one pre-existing convention (MachineService reports "none" when no
      // prior resolved value exists anywhere in the chain; applySettingChange
      // defaults to "org") — not something this unit changes.
      expect(Object.keys(eventA?.payload as object).sort()).toEqual(
        Object.keys(eventB?.payload as object).sort(),
      );
      expect(eventA?.payload).toEqual({
        key: "docker",
        previous: null,
        current: { versionPin: "24", pinned: false },
        overridesLevel: "none",
      });
      expect(eventB?.payload).toEqual({
        key: "docker",
        previous: null,
        current: { versionPin: "24", pinned: false },
        overridesLevel: "org",
      });
    });
  });
});
