import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { machines, orgs } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { connectTestDb } from "../../test-support/db";
import { recordHardeningBaseline } from "./hardening-baseline";

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
      await db.delete(machines).where(eq(machines.orgId, orgId));
      await db.delete(orgs).where(eq(orgs.id, orgId));
    }
  }
});

async function freshMachine(): Promise<string> {
  const [org] = await db.insert(orgs).values({ name: "Acme" }).returning();
  if (!org) throw new Error("org insert returned nothing");
  testOrgIds.push(org.id);
  const [machine] = await db
    .insert(machines)
    .values({
      orgId: org.id,
      ownerPersonId: null,
      name: "baseline-test",
      provider: "fake",
      region: "eastus",
      sizeSku: "Standard_B2s",
      image: "ubuntu-24.04",
      state: "running",
    })
    .returning();
  if (!machine) throw new Error("machine insert returned nothing");
  return machine.id;
}

const stored = async (machineId: string) => {
  const [row] = await db
    .select({ baseline: machines.hardeningBaseline })
    .from(machines)
    .where(eq(machines.id, machineId));
  return row?.baseline;
};

describe("recordHardeningBaseline", () => {
  test("a new machine has no baseline until it reports one", async () => {
    expect(await stored(await freshMachine())).toBeNull();
  });

  test("stores the label the agent reported", async () => {
    const id = await freshMachine();
    await Effect.runPromise(recordHardeningBaseline(db, id, "cis-ubuntu-l1-v1"));
    expect(await stored(id)).toBe("cis-ubuntu-l1-v1");
  });

  test("a report without one clears it, so a vanished stamp reads as none", async () => {
    const id = await freshMachine();
    await Effect.runPromise(recordHardeningBaseline(db, id, "cis-ubuntu-l1-v1"));
    await Effect.runPromise(recordHardeningBaseline(db, id, undefined));
    expect(await stored(id)).toBeNull();
  });

  test("only touches the machine it was told about", async () => {
    const a = await freshMachine();
    const b = await freshMachine();
    await Effect.runPromise(recordHardeningBaseline(db, a, "cis-ubuntu-l1-v1"));
    expect(await stored(b)).toBeNull();
  });
});
