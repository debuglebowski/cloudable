import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { DomainEvent } from "@cloudable/events";
import type * as schema from "@cloudable/schema";
import { events as eventsTable, settingValues } from "@cloudable/schema";
import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../db/layer";
import { LOGGING_TIER_KEY, type LoggingTier } from "../logging/settings";
import { cleanupOrgRows, connectTestDb } from "../test-support/db";
import { EventBus } from "./EventBus";

let db: PostgresJsDatabase<typeof schema>;
let close: () => Promise<void>;

beforeAll(() => {
  const conn = connectTestDb();
  db = conn.db;
  close = conn.close;
});

afterAll(async () => {
  await close();
});

const testOrgIds: string[] = [];
afterEach(async () => {
  while (testOrgIds.length > 0) {
    const orgId = testOrgIds.pop();
    if (orgId) await cleanupOrgRows(db, orgId);
  }
});

const freshOrgId = () => {
  const id = crypto.randomUUID();
  testOrgIds.push(id);
  return id;
};

// A direct fixture insert, not `setOrgLoggingTier` (which also records an
// `org.setting_changed` event — see `../logging/settings.test.ts`): these
// tests are about `EventBus.publish`'s tier-filtering decision alone, so
// seeding goes straight to the row it reads.
const seedLoggingTier = (orgId: string, tier: LoggingTier) =>
  db.insert(settingValues).values({
    scopeType: "org",
    scopeId: orgId,
    key: LOGGING_TIER_KEY,
    value: tier,
    source: "org",
  });

const publishViaBus = (batch: ReadonlyArray<DomainEvent>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.publish(batch);
    }).pipe(Effect.provide(EventBus.Default.pipe(Layer.provide(Layer.succeed(Db, db))))),
  );

const tier1Event = (orgId: string): DomainEvent => ({
  id: "placeholder", // overwritten by EventBus.publish
  type: "machine.created",
  occurredAt: new Date(),
  recordedAt: new Date(), // overwritten by EventBus.publish
  orgId,
  actorType: "person",
  actorId: "person-1",
  machineId: null,
  correlationId: crypto.randomUUID(),
  schemaVersion: 1,
  payload: {
    name: "dev-box",
    provider: "fake",
    region: "eastus",
    size: "Standard_B2s",
    image: "ubuntu-24.04",
  },
});

const tier2Event = (orgId: string): DomainEvent => ({
  id: "placeholder",
  type: "machine.state_reported",
  occurredAt: new Date(),
  recordedAt: new Date(),
  orgId,
  actorType: "system",
  actorId: "reconciler",
  machineId: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  schemaVersion: 1,
  payload: { changes: { agentVersion: "1.2.3" } },
});

const rowsForOrg = async (orgId: string) =>
  db.select().from(eventsTable).where(eq(eventsTable.orgId, orgId)).orderBy(asc(eventsTable.type));

describe("EventBus.publish — logging tier filtering", () => {
  test("org at tier 1: a tier-1 event lands, a tier-2 event is dropped", async () => {
    const orgId = freshOrgId();
    await seedLoggingTier(orgId, 1);

    await publishViaBus([tier1Event(orgId), tier2Event(orgId)]);

    const rows = await rowsForOrg(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("machine.created");
  });

  test("org at tier 2: both a tier-1 and a tier-2 event land", async () => {
    const orgId = freshOrgId();
    await seedLoggingTier(orgId, 2);

    await publishViaBus([tier1Event(orgId), tier2Event(orgId)]);

    const rows = await rowsForOrg(orgId);
    expect(rows.map((row) => row.type).sort()).toEqual([
      "machine.created",
      "machine.state_reported",
    ]);
  });

  test("org with no configured tier defaults to allowing tier-2 events (DEFAULT_LOGGING_TIER)", async () => {
    const orgId = freshOrgId();
    // No seeded setting_values row at all.

    await publishViaBus([tier1Event(orgId), tier2Event(orgId)]);

    const rows = await rowsForOrg(orgId);
    expect(rows.map((row) => row.type).sort()).toEqual([
      "machine.created",
      "machine.state_reported",
    ]);
  });

  test("tier-1 events are never dropped even when publishing tier-1 events alone at tier 1", async () => {
    const orgId = freshOrgId();
    await seedLoggingTier(orgId, 1);

    await publishViaBus([tier1Event(orgId)]);

    const rows = await rowsForOrg(orgId);
    expect(rows).toHaveLength(1);
  });

  test("dropping every event in a batch skips the insert without error", async () => {
    const orgId = freshOrgId();
    await seedLoggingTier(orgId, 1);

    await publishViaBus([tier2Event(orgId)]);

    const rows = await rowsForOrg(orgId);
    expect(rows).toHaveLength(0);
  });

  test("EventBus.publish still assigns a fresh id/recordedAt to surviving events", async () => {
    const orgId = freshOrgId();
    await seedLoggingTier(orgId, 1);

    await publishViaBus([tier1Event(orgId)]);

    const rows = await rowsForOrg(orgId);
    expect(rows[0]?.id).not.toBe("placeholder");
    expect(rows[0]?.id.length).toBeGreaterThan(0);
  });
});

describe("EventBus.publish — security export", () => {
  const grant = (orgId: string): DomainEvent => ({
    ...tier1Event(orgId),
    type: "person.role_changed",
    payload: { personId: "target-1", previous: "member", current: "admin" },
  });

  test("exports the persisted ID after append, even at logging tier 1", async () => {
    const orgId = freshOrgId();
    await seedLoggingTier(orgId, 1);
    const output = spyOn(console, "info").mockImplementation(() => {});
    try {
      await publishViaBus([grant(orgId)]);
      const rows = await rowsForOrg(orgId);
      const records = output.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        eventId: rows[0]?.id,
        subjectPersonId: "target-1",
        actorId: "person-1",
      });
      expect(records[0].eventId).not.toBe("placeholder");
    } finally {
      output.mockRestore();
    }
  });

  test("does not export an event whose append fails", async () => {
    const output = spyOn(console, "info").mockImplementation(() => {});
    // Tier-1-only batches do not query logging settings. Fail precisely at append.
    const failingDb = {
      insert: () => ({ values: () => Promise.reject(new Error("database unavailable")) }),
    } as unknown as typeof db;
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* EventBus;
          return yield* Effect.either(bus.publish([grant(crypto.randomUUID())]));
        }).pipe(Effect.provide(EventBus.Default.pipe(Layer.provide(Layer.succeed(Db, failingDb))))),
      );
      expect(result._tag).toBe("Left");
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });
});
