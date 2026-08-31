import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { DomainEvent } from "@cloudable/events";
import type * as schema from "@cloudable/schema";
import { settingValues } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { cleanupOrgRows, connectTestDb } from "../test-support/db";
import { LOGGING_TIER_KEY, type LoggingTier } from "./settings";
import { filterByLoggingTier } from "./tier-filter";

// Unit-level tests of `filterByLoggingTier` itself, isolated from
// `EventBus.publish` (see `../services/EventBus.test.ts` for the
// integration-level coverage of the whole publish path). These focus on
// the thing this unit added: a machine-scoped `logging_tier` row actually
// changing what gets filtered for that specific machine, without
// disturbing the tier-1-always-emitted invariant or any other org's/
// machine's own effective tier.

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
const testMachineIds: string[] = [];
afterEach(async () => {
  while (testOrgIds.length > 0) {
    const orgId = testOrgIds.pop();
    if (orgId) await cleanupOrgRows(db, orgId);
  }
  while (testMachineIds.length > 0) {
    const machineId = testMachineIds.pop();
    if (machineId) await db.delete(settingValues).where(eq(settingValues.scopeId, machineId));
  }
});

const freshOrgId = () => {
  const id = crypto.randomUUID();
  testOrgIds.push(id);
  return id;
};

const freshMachineId = () => {
  const id = crypto.randomUUID();
  testMachineIds.push(id);
  return id;
};

const seedTier = (scopeType: "org" | "machine", scopeId: string, tier: LoggingTier) =>
  db
    .insert(settingValues)
    .values({ scopeType, scopeId, key: LOGGING_TIER_KEY, value: tier, source: scopeType });

// Tier 1 (compliance floor) — carries no machineId in practice for most
// tier-1 types, but this unit's job is machine-level resolution, so most
// fixtures below give it one anyway to exercise that path.
const tier1Event = (orgId: string, machineId: string | null): DomainEvent => ({
  id: "placeholder",
  type: "machine.created",
  occurredAt: new Date(),
  recordedAt: new Date(),
  orgId,
  actorType: "person",
  actorId: "person-1",
  machineId,
  correlationId: crypto.randomUUID(),
  schemaVersion: 1,
  payload: { name: "dev-box", region: "eastus", size: "Standard_B2s", image: "ubuntu-24.04" },
});

// Tier 2 — the catalogue's real machine-scoped tier-2 type, same one
// `EventBus.test.ts` uses.
const tier2Event = (orgId: string, machineId: string): DomainEvent => ({
  id: "placeholder",
  type: "machine.state_reported",
  occurredAt: new Date(),
  recordedAt: new Date(),
  orgId,
  actorType: "system",
  actorId: "reconciler",
  machineId,
  correlationId: crypto.randomUUID(),
  schemaVersion: 1,
  payload: { changes: { agentVersion: "1.2.3" } },
});

// A machine.setting_changed event recording a change to a given key —
// tier 2, same as tier2Event above, but with the real `machine.setting_
// changed` payload shape so the `payload.key === LOGGING_TIER_KEY`
// exemption in `filterByLoggingTier` can be exercised precisely.
const settingChangedEvent = (orgId: string, machineId: string, key: string): DomainEvent => ({
  id: "placeholder",
  type: "machine.setting_changed",
  occurredAt: new Date(),
  recordedAt: new Date(),
  orgId,
  actorType: "person",
  actorId: "person-1",
  machineId,
  correlationId: crypto.randomUUID(),
  schemaVersion: 1,
  payload: { key, previous: 2, current: 1, overridesLevel: "org" },
});

const run = (batch: ReadonlyArray<DomainEvent>) =>
  Effect.runPromise(filterByLoggingTier(db, batch));

describe("filterByLoggingTier (spec §17)", () => {
  test("tier-1 events are never dropped, even for a machine whose own override is below tier 1's requirement", async () => {
    const orgId = freshOrgId();
    const machineId = freshMachineId();
    await seedTier("org", orgId, 3);
    await seedTier("machine", machineId, 1);

    const result = await run([tier1Event(orgId, machineId)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("machine.created");
  });

  test("tier-1 events are never dropped even with no configuration at all", async () => {
    const orgId = freshOrgId();
    const machineId = freshMachineId();
    // No org or machine setting_values row seeded.

    const result = await run([tier1Event(orgId, machineId)]);

    expect(result).toHaveLength(1);
  });

  test("a machine-level override changes filtering for that machine specifically, independent of the org default", async () => {
    const orgId = freshOrgId();
    const overriddenMachine = freshMachineId();
    const plainMachine = freshMachineId();

    // Org default would drop a tier-2 event...
    await seedTier("org", orgId, 1);
    // ...but this machine has its own override raising it to tier 3.
    await seedTier("machine", overriddenMachine, 3);

    const result = await run([
      tier2Event(orgId, overriddenMachine),
      tier2Event(orgId, plainMachine),
    ]);

    // The overridden machine's event survives; the other machine in the
    // same org, with no override of its own, still falls back to the org
    // default and gets dropped.
    expect(result).toHaveLength(1);
    expect(result[0]?.machineId).toBe(overriddenMachine);
  });

  test("a machine-level override can also lower the effective tier below the org default", async () => {
    const orgId = freshOrgId();
    const overriddenMachine = freshMachineId();
    const plainMachine = freshMachineId();

    // Org default allows tier-2 events through...
    await seedTier("org", orgId, 2);
    // ...but this machine overrides down to tier 1, below the tier-2 event's requirement.
    await seedTier("machine", overriddenMachine, 1);

    const result = await run([
      tier2Event(orgId, overriddenMachine),
      tier2Event(orgId, plainMachine),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.machineId).toBe(plainMachine);
  });

  test("a machine with no override falls back to the org default", async () => {
    const orgId = freshOrgId();
    const machineId = freshMachineId();
    await seedTier("org", orgId, 2);

    const result = await run([tier2Event(orgId, machineId)]);

    expect(result).toHaveLength(1);
  });

  test("with nothing configured anywhere, a tier-2 event is allowed through (DEFAULT_LOGGING_TIER)", async () => {
    const orgId = freshOrgId();
    const machineId = freshMachineId();

    const result = await run([tier2Event(orgId, machineId)]);

    expect(result).toHaveLength(1);
  });

  test("an org-scoped event (no machineId) takes the plain org-default path without touching any machine's override", async () => {
    const orgId = freshOrgId();
    const otherMachine = freshMachineId();
    await seedTier("org", orgId, 1);
    // A machine in the same org has a much higher override — the
    // machineId:null branch must not accidentally pick this up.
    await seedTier("machine", otherMachine, 3);

    // No tier-2+ event type is ever org-scoped in the real catalogue (see
    // `filterByLoggingTier`'s doc comment), so this only exercises that the
    // machineId:null branch runs cleanly alongside an unrelated machine
    // override in the same batch — real tier-1-always-emitted coverage is
    // the other tests above.
    const result = await run([tier1Event(orgId, null)]);

    expect(result).toHaveLength(1);
  });

  test("a machine's own logging_tier change is never dropped, even by the very downgrade it records", async () => {
    const orgId = freshOrgId();
    const machineId = freshMachineId();
    // Simulates the write having already committed by the time publish
    // (and therefore this filter) runs: the machine's own tier is now 1,
    // below `machine.setting_changed`'s tier-2 requirement. Without the
    // exemption, the event recording this exact downgrade would be
    // dropped by the tier it just set.
    await seedTier("machine", machineId, 1);

    const result = await run([settingChangedEvent(orgId, machineId, LOGGING_TIER_KEY)]);

    expect(result).toHaveLength(1);
  });

  test("the logging_tier exemption is scoped to that key — a same-tier change to a different key is still filtered normally", async () => {
    const orgId = freshOrgId();
    const machineId = freshMachineId();
    await seedTier("machine", machineId, 1);

    const result = await run([settingChangedEvent(orgId, machineId, "region")]);

    expect(result).toHaveLength(0);
  });
});
