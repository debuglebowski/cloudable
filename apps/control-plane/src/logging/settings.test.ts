import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { events, settingValues } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { cleanupOrgRows, connectTestDb } from "../test-support/db";
import {
  DEFAULT_LOGGING_TIER,
  DEFAULT_RETENTION_LOCATION,
  getOrgLoggingTier,
  getOrgRetentionLocation,
  setOrgLoggingTier,
  setOrgRetentionLocation,
} from "./settings";

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
const testMachineScopeIds: string[] = [];
afterEach(async () => {
  while (testOrgIds.length > 0) {
    const orgId = testOrgIds.pop();
    if (orgId) await cleanupOrgRows(db, orgId);
  }
  while (testMachineScopeIds.length > 0) {
    const scopeId = testMachineScopeIds.pop();
    if (scopeId) await db.delete(settingValues).where(eq(settingValues.scopeId, scopeId));
  }
});

const freshOrgId = () => {
  const id = crypto.randomUUID();
  testOrgIds.push(id);
  return id;
};

const testActor = { actorType: "person" as const, actorId: "person-1" };

describe("logging settings (spec §17)", () => {
  test("getOrgLoggingTier defaults when unset", async () => {
    const orgId = freshOrgId();
    const tier = await Effect.runPromise(getOrgLoggingTier(db, orgId));
    expect(tier).toBe(DEFAULT_LOGGING_TIER);
  });

  test("getOrgRetentionLocation defaults when unset", async () => {
    const orgId = freshOrgId();
    const location = await Effect.runPromise(getOrgRetentionLocation(db, orgId));
    expect(location).toBe(DEFAULT_RETENTION_LOCATION);
  });

  test("set/get round-trips a logging tier", async () => {
    const orgId = freshOrgId();
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 3, testActor));
    const tier = await Effect.runPromise(getOrgLoggingTier(db, orgId));
    expect(tier).toBe(3);
  });

  test("set/get round-trips a retention location", async () => {
    const orgId = freshOrgId();
    await Effect.runPromise(
      setOrgRetentionLocation(db, orgId, "cloudable_sweden_central", testActor),
    );
    const location = await Effect.runPromise(getOrgRetentionLocation(db, orgId));
    expect(location).toBe("cloudable_sweden_central");
  });

  test("re-setting a tier replaces the previous value rather than accumulating rows", async () => {
    const orgId = freshOrgId();
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 1, testActor));
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 3, testActor));

    const rows = await db.select().from(settingValues).where(eq(settingValues.scopeId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(3);
  });

  test("retention location has no per-machine override: a machine-scoped row is never read by getOrgRetentionLocation", async () => {
    const orgId = freshOrgId();
    await Effect.runPromise(setOrgRetentionLocation(db, orgId, "customer", testActor));

    // Simulate a hypothetical (invalid) attempt to override retention_location
    // at machine scope by writing directly to `setting_values` — there is no
    // exported setter that could produce this row; only a raw insert can.
    const rogueMachineId = crypto.randomUUID();
    testMachineScopeIds.push(rogueMachineId);
    await db.insert(settingValues).values({
      scopeType: "machine",
      scopeId: rogueMachineId,
      key: "retention_location",
      value: "cloudable_sweden_central",
      source: "machine",
    });

    // Org-scoped read must be unaffected by the machine-scoped row above —
    // retention location is an org-only setting (spec §17: "no per-machine
    // override").
    const location = await Effect.runPromise(getOrgRetentionLocation(db, orgId));
    expect(location).toBe("customer");
  });

  test("changing a setting records an org.setting_changed event (tier 1, always audited)", async () => {
    const orgId = freshOrgId();
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 1, testActor));
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 3, testActor));

    const rows = await db.select().from(events).where(eq(events.orgId, orgId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.type === "org.setting_changed")).toBe(true);
    expect(rows.every((row) => row.actorType === "person" && row.actorId === "person-1")).toBe(
      true,
    );

    const payloads = rows.map(
      (row) => row.payload as { key: string; previous: unknown; current: unknown; level: string },
    );
    expect(payloads.every((p) => p.key === "logging_tier" && p.level === "org")).toBe(true);
    expect(payloads.map((p) => p.current).sort()).toEqual([1, 3]);
  });

  test("the recorded event's previous/current reflect the actual transition, including the default as 'previous'", async () => {
    const orgId = freshOrgId();
    // No prior setting_values row — the recorded "previous" should be DEFAULT_LOGGING_TIER.
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 3, testActor));

    const rows = await db.select().from(events).where(eq(events.orgId, orgId));
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as { previous: unknown; current: unknown };
    expect(payload.previous).toBe(DEFAULT_LOGGING_TIER);
    expect(payload.current).toBe(3);
  });
});
