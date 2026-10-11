import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, machines, orgs, settingValues, snapshots } from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { ulid } from "ulid";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { isDbReachable } from "../../testing/db-reachable";
import { EVENTS_RETENTION_DAYS_KEY } from "./policy";
import { expireEventsPastRetention, expireOrgEvents } from "./sweep";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

// Real Postgres: the sweep is one correlated DELETE plus an insert in a transaction, and
// every property worth testing (group protection, legal hold, atomic record) is a
// property of that SQL, so a fake store would test nothing.
const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("event retention sweep (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db>;
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    TestLayer = Layer.succeed(Db, db);
  });

  afterAll(async () => {
    // Tests are the one place events may be deleted outside the sweep: these orgs exist
    // only for this file and nothing else should find their rows afterwards.
    if (createdOrgIds.length > 0) {
      await db.delete(events).where(inArray(events.orgId, createdOrgIds));
      await db.delete(snapshots).where(inArray(snapshots.orgId, createdOrgIds));
      await db.delete(settingValues).where(inArray(settingValues.scopeId, createdOrgIds));
      await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
      await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    }
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
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
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  async function seedSnapshot(orgId: string, machineId: string, legalHold: boolean) {
    await db.insert(snapshots).values({
      orgId,
      machineId,
      trigger: "manual",
      region: "eastus",
      legalHold,
      retentionDays: 30,
      expiresAt: daysAgo(-30),
    });
  }

  async function seedEvent(
    orgId: string,
    opts: {
      ageDays: number;
      machineId?: string | null;
      correlationId?: string;
      actorId?: string;
      payload?: unknown;
    },
  ) {
    const id = ulid();
    await db.insert(events).values({
      id,
      type: "org.setting_changed",
      occurredAt: daysAgo(opts.ageDays),
      orgId,
      actorType: "person",
      actorId: opts.actorId ?? "person-1",
      machineId: opts.machineId ?? null,
      correlationId: opts.correlationId ?? ulid(),
      schemaVersion: 1,
      payload: opts.payload ?? {},
    });
    return id;
  }

  const eventIdsOf = async (orgId: string) =>
    (await db.select({ id: events.id }).from(events).where(eq(events.orgId, orgId))).map(
      (row) => row.id,
    );

  const expiryRecordsOf = async (orgId: string) =>
    (await db.select().from(events).where(eq(events.orgId, orgId))).filter(
      (row) => row.type === "org.events_expired",
    );

  describe("expireOrgEvents", () => {
    test("deletes events past the window and keeps the ones inside it", async () => {
      const org = await seedOrg();
      const old = await seedEvent(org.id, { ageDays: 400 });
      const justPast = await seedEvent(org.id, { ageDays: 366 });
      const justInside = await seedEvent(org.id, { ageDays: 364 });
      const recent = await seedEvent(org.id, { ageDays: 1 });

      const deleted = await run(expireOrgEvents(org.id, 365));

      expect(deleted).toBe(2);
      const remaining = await eventIdsOf(org.id);
      expect(remaining).not.toContain(old);
      expect(remaining).not.toContain(justPast);
      expect(remaining).toContain(justInside);
      expect(remaining).toContain(recent);
    });

    test("records the deletion as org.events_expired with the cutoff, window and count, and nothing from the rows it removed", async () => {
      const org = await seedOrg();
      await seedEvent(org.id, {
        ageDays: 400,
        actorId: "someone-identifiable",
        payload: { email: "someone@example.test", reason: "a free-text reason" },
      });
      await seedEvent(org.id, { ageDays: 500 });

      const before = Date.now();
      await run(expireOrgEvents(org.id, 365));

      const [record] = await expiryRecordsOf(org.id);
      expect(record).toBeDefined();
      expect(record?.actorType).toBe("system");
      expect(record?.machineId).toBeNull();
      const payload = record?.payload as {
        cutoff: string;
        retentionDays: number;
        deletedCount: number;
      };
      expect(Object.keys(payload).sort()).toEqual(["cutoff", "deletedCount", "retentionDays"]);
      expect(payload.deletedCount).toBe(2);
      expect(payload.retentionDays).toBe(365);
      const cutoff = new Date(payload.cutoff).getTime();
      expect(cutoff).toBeGreaterThanOrEqual(before - 365 * DAY_MS - 5_000);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - 365 * DAY_MS + 5_000);
      expect(JSON.stringify(record)).not.toContain("someone-identifiable");
      expect(JSON.stringify(record)).not.toContain("someone@example.test");
    });

    test("is a no-op with no record when nothing is past the window, and idempotent when something was", async () => {
      const org = await seedOrg();
      await seedEvent(org.id, { ageDays: 10 });

      expect(await run(expireOrgEvents(org.id, 365))).toBe(0);
      expect(await expiryRecordsOf(org.id)).toHaveLength(0);

      await seedEvent(org.id, { ageDays: 400 });
      expect(await run(expireOrgEvents(org.id, 365))).toBe(1);
      expect(await expiryRecordsOf(org.id)).toHaveLength(1);

      // Nothing is left to delete, so a second run must not write a second record
      // claiming it did.
      expect(await run(expireOrgEvents(org.id, 365))).toBe(0);
      expect(await expiryRecordsOf(org.id)).toHaveLength(1);
    });

    test("never touches another org's events", async () => {
      const org = await seedOrg();
      const otherOrg = await seedOrg();
      await seedEvent(org.id, { ageDays: 400 });
      const othersOld = await seedEvent(otherOrg.id, { ageDays: 400 });

      await run(expireOrgEvents(org.id, 365));

      expect(await eventIdsOf(otherOrg.id)).toContain(othersOld);
      expect(await expiryRecordsOf(otherOrg.id)).toHaveLength(0);
    });

    test("keeps an old event while any event in its correlation group is still inside the window", async () => {
      const org = await seedOrg();
      // e.g. an approval and the elevation it authorised: one operation, one correlation
      // id, written a little apart. The cutoff falls between them.
      const correlationId = ulid();
      const approval = await seedEvent(org.id, { ageDays: 366, correlationId });
      const grant = await seedEvent(org.id, { ageDays: 364, correlationId });
      const unrelated = await seedEvent(org.id, { ageDays: 366 });

      expect(await run(expireOrgEvents(org.id, 365))).toBe(1);
      const remaining = await eventIdsOf(org.id);
      expect(remaining).toContain(approval);
      expect(remaining).toContain(grant);
      expect(remaining).not.toContain(unrelated);

      // Once the whole group is past the window it goes together.
      expect(await run(expireOrgEvents(org.id, 300))).toBe(2);
      const afterwards = await eventIdsOf(org.id);
      expect(afterwards).not.toContain(approval);
      expect(afterwards).not.toContain(grant);
    });

    test("keeps the events of a machine with a snapshot under legal hold, and the rest of their group, until the hold is cleared", async () => {
      const org = await seedOrg();
      const held = await seedMachine(org.id);
      const free = await seedMachine(org.id);
      await seedSnapshot(org.id, held.id, true);
      await seedSnapshot(org.id, free.id, false);

      const heldEvent = await seedEvent(org.id, { ageDays: 400, machineId: held.id });
      const freeEvent = await seedEvent(org.id, { ageDays: 400, machineId: free.id });
      // Org-level events are not covered by a machine's hold on their own...
      const orgLevel = await seedEvent(org.id, { ageDays: 400 });
      // ...unless they are part of the same operation as a held machine's event.
      const groupId = ulid();
      const heldInGroup = await seedEvent(org.id, {
        ageDays: 400,
        machineId: held.id,
        correlationId: groupId,
      });
      const orgLevelInGroup = await seedEvent(org.id, { ageDays: 400, correlationId: groupId });

      expect(await run(expireOrgEvents(org.id, 365))).toBe(2);
      const remaining = await eventIdsOf(org.id);
      expect(remaining).toContain(heldEvent);
      expect(remaining).toContain(heldInGroup);
      expect(remaining).toContain(orgLevelInGroup);
      expect(remaining).not.toContain(freeEvent);
      expect(remaining).not.toContain(orgLevel);

      await db.update(snapshots).set({ legalHold: false }).where(eq(snapshots.machineId, held.id));
      expect(await run(expireOrgEvents(org.id, 365))).toBe(3);
      expect(await eventIdsOf(org.id)).not.toContain(heldEvent);
    });

    test("a hold in one org does not protect another org's events", async () => {
      const heldOrg = await seedOrg();
      const otherOrg = await seedOrg();
      const heldMachine = await seedMachine(heldOrg.id);
      await seedSnapshot(heldOrg.id, heldMachine.id, true);
      const otherOld = await seedEvent(otherOrg.id, { ageDays: 400 });

      await run(expireOrgEvents(otherOrg.id, 365));

      expect(await eventIdsOf(otherOrg.id)).not.toContain(otherOld);
    });
  });

  describe("expireEventsPastRetention", () => {
    const setWindow = (orgId: string, value: unknown) =>
      db.insert(settingValues).values({
        scopeType: "org",
        scopeId: orgId,
        key: EVENTS_RETENTION_DAYS_KEY,
        value,
        source: "org",
      });

    test("applies each org's own window: the default, a configured one, and the floor over a stored value below it", async () => {
      const defaulted = await seedOrg();
      const configured = await seedOrg();
      const belowFloor = await seedOrg();
      await setWindow(configured.id, 100);
      // Written around the validation, as a hand-edited row or an old import would be.
      await setWindow(belowFloor.id, 5);

      const defaultedAt200 = await seedEvent(defaulted.id, { ageDays: 200 });
      const defaultedAt400 = await seedEvent(defaulted.id, { ageDays: 400 });
      const configuredAt200 = await seedEvent(configured.id, { ageDays: 200 });
      const configuredAt50 = await seedEvent(configured.id, { ageDays: 50 });
      const floorAt100 = await seedEvent(belowFloor.id, { ageDays: 100 });
      const floorAt60 = await seedEvent(belowFloor.id, { ageDays: 60 });

      // Limited to this test's own orgs: an unrestricted pass would sweep every org in
      // the shared database.
      await run(
        expireEventsPastRetention(new Date(), [defaulted.id, configured.id, belowFloor.id]),
      );

      expect(await eventIdsOf(defaulted.id)).toContain(defaultedAt200);
      expect(await eventIdsOf(defaulted.id)).not.toContain(defaultedAt400);
      expect(await eventIdsOf(configured.id)).not.toContain(configuredAt200);
      expect(await eventIdsOf(configured.id)).toContain(configuredAt50);
      // 5 days would have wiped almost everything; the floor of 90 keeps the 60-day-old one.
      expect(await eventIdsOf(belowFloor.id)).not.toContain(floorAt100);
      expect(await eventIdsOf(belowFloor.id)).toContain(floorAt60);

      const record = (await expiryRecordsOf(belowFloor.id))[0];
      expect((record?.payload as { retentionDays: number }).retentionDays).toBe(90);
    });
  });
});
