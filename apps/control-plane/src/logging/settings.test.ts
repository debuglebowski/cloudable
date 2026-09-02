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
  LOGGING_TIER_KEY,
  getEffectiveLoggingTier,
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

describe("logging settings", () => {
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
    // retention location is an org-only setting with no per-machine override.
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

describe("getEffectiveLoggingTier — machine-level override", () => {
  test("defaults to DEFAULT_LOGGING_TIER with source 'org' when nothing is set anywhere", async () => {
    const orgId = freshOrgId();
    const machineId = crypto.randomUUID();
    testMachineScopeIds.push(machineId);

    const resolved = await Effect.runPromise(getEffectiveLoggingTier(db, { orgId, machineId }));
    expect(resolved).toEqual({ tier: DEFAULT_LOGGING_TIER, source: "org" });
  });

  test("resolves the org value with source 'org' when the machine has no override of its own", async () => {
    const orgId = freshOrgId();
    const machineId = crypto.randomUUID();
    testMachineScopeIds.push(machineId);
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 3, testActor));

    const resolved = await Effect.runPromise(getEffectiveLoggingTier(db, { orgId, machineId }));
    expect(resolved).toEqual({ tier: 3, source: "org" });
  });

  test("a machine-scoped row wins over the org value, with source 'machine'", async () => {
    const orgId = freshOrgId();
    const machineId = crypto.randomUUID();
    testMachineScopeIds.push(machineId);
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 1, testActor));
    await db.insert(settingValues).values({
      scopeType: "machine",
      scopeId: machineId,
      key: LOGGING_TIER_KEY,
      value: 3,
      source: "machine",
    });

    const resolved = await Effect.runPromise(getEffectiveLoggingTier(db, { orgId, machineId }));
    expect(resolved).toEqual({ tier: 3, source: "machine" });
  });

  test("a machine-scoped row wins even when the org has never configured a tier at all", async () => {
    const orgId = freshOrgId();
    const machineId = crypto.randomUUID();
    testMachineScopeIds.push(machineId);
    await db.insert(settingValues).values({
      scopeType: "machine",
      scopeId: machineId,
      key: LOGGING_TIER_KEY,
      value: 1,
      source: "machine",
    });

    const resolved = await Effect.runPromise(getEffectiveLoggingTier(db, { orgId, machineId }));
    expect(resolved).toEqual({ tier: 1, source: "machine" });
  });

  test("a machine's override never leaks to a different machine in the same org", async () => {
    const orgId = freshOrgId();
    const overriddenMachine = crypto.randomUUID();
    const plainMachine = crypto.randomUUID();
    testMachineScopeIds.push(overriddenMachine, plainMachine);
    await Effect.runPromise(setOrgLoggingTier(db, orgId, 2, testActor));
    await db.insert(settingValues).values({
      scopeType: "machine",
      scopeId: overriddenMachine,
      key: LOGGING_TIER_KEY,
      value: 3,
      source: "machine",
    });

    const overridden = await Effect.runPromise(
      getEffectiveLoggingTier(db, { orgId, machineId: overriddenMachine }),
    );
    const plain = await Effect.runPromise(
      getEffectiveLoggingTier(db, { orgId, machineId: plainMachine }),
    );
    expect(overridden).toEqual({ tier: 3, source: "machine" });
    expect(plain).toEqual({ tier: 2, source: "org" });
  });
});
