import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { machinePackages, machines, orgs } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { noUndeclaredSoftwareCheck } from "./no-undeclared-software";

/** `.returning()` always yields exactly one row for a single-row insert. */
function mustFirst<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected at least one row");
  return row;
}

/** Stands in for an image's own packages. Subtracting these is what makes the check
 * usable: a real Ubuntu image is several hundred packages, and without the subtraction
 * every machine reports several hundred findings on its first check-in. */
const BASELINE = ["bash", "coreutils"];

describe("noUndeclaredSoftwareCheck", () => {
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
    Effect.runPromise(
      Effect.provide(noUndeclaredSoftwareCheck.evaluate({ orgId }), Layer.succeed(Db, db)),
    );

  async function makeMachine(opts: { state?: (typeof machines.$inferInsert)["state"] } = {}) {
    return mustFirst(
      await db
        .insert(machines)
        .values({
          orgId,
          name: "m",
          provider: "fake",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          ...(opts.state ? { state: opts.state } : {}),
        })
        .returning(),
    );
  }

  /**
   * Undeclared software is now derived from state, not from drift events.
   *
   * This file used to seed `machine.drift_detected` / `machine.drift_resolved` events
   * and assert the check read them. It no longer does: the check computes
   * "reported inventory, minus the image baseline, minus anything allowed" straight
   * from `machines.installedPackages`, `machines.baselinePackages` and the manifest,
   * through the same `buildPackagesView` the console's package table uses.
   *
   * Seeding events against the rewritten check did not merely fail — three of the six
   * tests here PASSED while asserting "no finding", because nothing was ever detected.
   * A check that has stopped detecting looks identical to a fleet with nothing to find,
   * which is the failure mode this whole suite exists to rule out. Every test below now
   * asserts a positive detection or a specific reason for its absence.
   */
  async function setInventory(
    machineId: string,
    installedPackages: string[],
    baselinePackages: string[] = BASELINE,
  ) {
    await db
      .update(machines)
      .set({ installedPackages, baselinePackages })
      .where(eq(machines.id, machineId));
  }

  /** Allow a package at machine scope — the other way drift resolves, alongside
   * someone actually removing the software. */
  async function allowPackage(machineId: string, packageName: string) {
    await db.insert(machinePackages).values({
      scopeType: "machine",
      scopeId: machineId,
      packageName,
      source: "machine",
    });
  }

  test("installed software nobody allowed -> finding carrying it", async () => {
    const machine = await makeMachine();
    await setInventory(machine.id, [...BASELINE, "curl-extra"]);

    const findings = await evaluate();
    const finding = findings.find((f) => f.machineId === machine.id);
    expect(finding).toBeDefined();
    expect(finding?.checkId).toBe("no-undeclared-software");
    expect(finding?.detail).toEqual({ undeclaredPackages: ["curl-extra"] });
  });

  test("the same software, once allowed by the manifest -> no finding", async () => {
    const machine = await makeMachine();
    await setInventory(machine.id, [...BASELINE, "curl-extra"]);
    await allowPackage(machine.id, "curl-extra");

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("machine that has never reported an inventory -> no finding", async () => {
    // Silence is not evidence of cleanliness. A machine that has told us nothing is
    // the "machines are reporting" check's business, not this one's.
    const machine = await makeMachine();

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("archived machine with undeclared software -> no finding (gated out as not-live)", async () => {
    const machine = await makeMachine({ state: "archived_restorable" });
    await setInventory(machine.id, [...BASELINE, "curl-extra"]);

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("software removed, then different software appears -> finding again", async () => {
    const machine = await makeMachine();
    await setInventory(machine.id, [...BASELINE, "curl-extra"]);
    await setInventory(machine.id, [...BASELINE]);
    await setInventory(machine.id, [...BASELINE, "vim-extra"]);

    const findings = await evaluate();
    const finding = findings.find((f) => f.machineId === machine.id);
    expect(finding).toBeDefined();
    expect(finding?.detail).toEqual({ undeclaredPackages: ["vim-extra"] });
  });

  // Regression test for the finding-age reopen bug (docs/compliance.md,
  // "a finding that closes and later reopens is treated as newly opened"):
  // without `clearResolvedFindings`, the state row from the first drift
  // survives the resolution and the re-drift reports the ORIGINAL, stale
  // `firstSeenAt` instead of a fresh one. Unlike the test above, this one
  // evaluates between each step so the state row is actually cleared while
  // the finding is resolved.
  test("closes and reopens across evaluations -> firstSeenAt resets, not the stale original", async () => {
    const machine = await makeMachine();
    await setInventory(machine.id, [...BASELINE, "curl-extra"]);

    const opened = await evaluate();
    const openedFinding = opened.find((f) => f.machineId === machine.id);
    expect(openedFinding).toBeDefined();
    const firstSeenAt = openedFinding?.firstSeenAt;

    await setInventory(machine.id, [...BASELINE]);
    const resolved = await evaluate();
    expect(resolved.find((f) => f.machineId === machine.id)).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await setInventory(machine.id, [...BASELINE, "vim-extra"]);
    const reopened = await evaluate();
    const reopenedFinding = reopened.find((f) => f.machineId === machine.id);
    expect(reopenedFinding).toBeDefined();
    expect(reopenedFinding?.firstSeenAt.getTime()).not.toBe(firstSeenAt?.getTime());
    expect(reopenedFinding?.firstSeenAt.getTime()).toBeGreaterThan(firstSeenAt?.getTime() ?? 0);
  });
});
