import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { machines, orgs, people } from "@cloudable/schema";
import { Effect, Layer } from "effect";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { activeOwnerCheck } from "./active-owner";

/** `.returning()` always yields exactly one row for a single-row insert. */
function mustFirst<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected at least one row");
  return row;
}

describe("activeOwnerCheck", () => {
  let db: Awaited<ReturnType<typeof startTestDb>>["db"];
  let stop: Awaited<ReturnType<typeof startTestDb>>["stop"];
  let orgId: string;

  beforeAll(async () => {
    const testDb = await startTestDb();
    db = testDb.db;
    stop = testDb.stop;

    const org = mustFirst(await db.insert(orgs).values({ name: "Acme" }).returning());
    orgId = org.id;
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  const evaluate = () =>
    Effect.runPromise(Effect.provide(activeOwnerCheck.evaluate({ orgId }), Layer.succeed(Db, db)));

  async function makePerson(active: boolean) {
    return mustFirst(
      await db
        .insert(people)
        .values({
          orgId,
          email: `${crypto.randomUUID()}@example.com`,
          active,
          deactivatedAt: active ? null : new Date(),
        })
        .returning(),
    );
  }

  async function makeMachine(opts: {
    ownerPersonId: string | null;
    state?: (typeof machines.$inferInsert)["state"];
  }) {
    return mustFirst(
      await db
        .insert(machines)
        .values({
          orgId,
          ownerPersonId: opts.ownerPersonId,
          name: "m",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          state: opts.state ?? "running",
        })
        .returning(),
    );
  }

  test("owner present and active -> no finding", async () => {
    const owner = await makePerson(true);
    await makeMachine({ ownerPersonId: owner.id });

    const findings = await evaluate();
    expect(findings.find((f) => f.detail.ownerPersonId === owner.id)).toBeUndefined();
  });

  test("owner null -> finding with reason no_owner", async () => {
    const machine = await makeMachine({ ownerPersonId: null });

    const findings = await evaluate();
    const finding = findings.find((f) => f.machineId === machine.id);
    expect(finding).toBeDefined();
    expect(finding?.checkId).toBe("active-owner");
    expect(finding?.detail).toEqual({ ownerPersonId: null, reason: "no_owner" });
  });

  test("owner deactivated -> finding with reason owner_deactivated", async () => {
    const owner = await makePerson(false);
    const machine = await makeMachine({ ownerPersonId: owner.id });

    const findings = await evaluate();
    const finding = findings.find((f) => f.machineId === machine.id);
    expect(finding).toBeDefined();
    expect(finding?.detail).toEqual({ ownerPersonId: owner.id, reason: "owner_deactivated" });
  });

  test("archived machine with no owner -> no finding (gated out as not-live)", async () => {
    const machine = await makeMachine({ ownerPersonId: null, state: "archived_restorable" });

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("firstSeenAt is stable across evaluations for the same open finding", async () => {
    const machine = await makeMachine({ ownerPersonId: null });

    const first = await evaluate();
    const firstFinding = first.find((f) => f.machineId === machine.id);
    expect(firstFinding).toBeDefined();

    const second = await evaluate();
    const secondFinding = second.find((f) => f.machineId === machine.id);
    expect(secondFinding).toBeDefined();

    expect(secondFinding?.firstSeenAt.getTime()).toBe(firstFinding?.firstSeenAt.getTime());
  });
});
