import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { machines, orgs, settingValues } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { LOGGING_TIER_KEY } from "../../logging/settings";
import { connectTestDb } from "../../test-support/db";
import { getOrgSettings } from "./settings";

// Focused on `loggingTierOverrideCount` — the one genuinely new query this
// unit added to `getOrgSettings` (an `innerJoin` scoping a `settingValues`
// count to one org's own machines). Every other field on `OrgSettingsView`
// is exercised indirectly by `logging/settings.test.ts` and
// `ApprovalService`'s own tests; this file exists so the join itself has
// direct coverage.

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
    if (orgId) {
      await db.delete(settingValues).where(eq(settingValues.scopeId, orgId));
      await db.delete(machines).where(eq(machines.orgId, orgId));
      await db.delete(orgs).where(eq(orgs.id, orgId));
    }
  }
});

async function seedOrg(): Promise<string> {
  const [org] = await db
    .insert(orgs)
    .values({ name: `settings-test-${crypto.randomUUID()}` })
    .returning();
  if (!org) throw new Error("seed failed");
  testOrgIds.push(org.id);
  return org.id;
}

async function seedMachine(orgId: string): Promise<string> {
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
  return machine.id;
}

const run = (orgId: string) =>
  Effect.runPromise(Effect.provideService(getOrgSettings(orgId), Db, db));

const seedMachineOverride = (machineId: string, tier: 1 | 2 | 3) =>
  db.insert(settingValues).values({
    scopeType: "machine",
    scopeId: machineId,
    key: LOGGING_TIER_KEY,
    value: tier,
    source: "machine",
  });

describe("getOrgSettings — loggingTierOverrideCount", () => {
  test("is 0 when no machine in the org has its own logging-tier override", async () => {
    const orgId = await seedOrg();
    await seedMachine(orgId);

    const settings = await run(orgId);
    expect(settings.loggingTierOverrideCount).toBe(0);
  });

  test("counts machine-scoped logging_tier rows, one per overriding machine", async () => {
    const orgId = await seedOrg();
    const overriddenMachine = await seedMachine(orgId);
    await seedMachine(orgId); // a second machine with no override of its own

    await seedMachineOverride(overriddenMachine, 3);

    const settings = await run(orgId);
    expect(settings.loggingTierOverrideCount).toBe(1);
  });

  test("never counts another org's machine-level override", async () => {
    const orgId = await seedOrg();
    await seedMachine(orgId);

    const otherOrgId = await seedOrg();
    const otherMachine = await seedMachine(otherOrgId);
    await seedMachineOverride(otherMachine, 1);

    const settings = await run(orgId);
    expect(settings.loggingTierOverrideCount).toBe(0);

    const otherSettings = await run(otherOrgId);
    expect(otherSettings.loggingTierOverrideCount).toBe(1);
  });
});
