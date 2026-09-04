import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { events, machines, orgs } from "@cloudable/schema";
import { Effect, Layer } from "effect";
import { ulid } from "ulid";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { noUndeclaredSoftwareCheck } from "./no-undeclared-software";

/** `.returning()` always yields exactly one row for a single-row insert. */
function mustFirst<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected at least one row");
  return row;
}

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

  async function recordDrift(machineId: string, occurredAt: Date, undeclaredPackages: string[]) {
    await db.insert(events).values({
      id: ulid(),
      type: "machine.drift_detected",
      occurredAt,
      orgId,
      actorType: "agent",
      actorId: "agent-1",
      machineId,
      correlationId: ulid(),
      schemaVersion: 1,
      payload: { undeclaredPackages, undeclaredPorts: [] },
    });
  }

  async function resolveDrift(machineId: string, occurredAt: Date) {
    await db.insert(events).values({
      id: ulid(),
      type: "machine.drift_resolved",
      occurredAt,
      orgId,
      actorType: "person",
      actorId: "person-1",
      machineId,
      correlationId: ulid(),
      schemaVersion: 1,
      payload: { removed: [], approvalId: ulid() },
    });
  }

  test("machine with open drift -> finding carrying the undeclared packages", async () => {
    const machine = await makeMachine();
    await recordDrift(machine.id, new Date("2026-01-01T00:00:00Z"), ["curl-extra"]);

    const findings = await evaluate();
    const finding = findings.find((f) => f.machineId === machine.id);
    expect(finding).toBeDefined();
    expect(finding?.checkId).toBe("no-undeclared-software");
    expect(finding?.detail).toEqual({ undeclaredPackages: ["curl-extra"] });
  });

  test("machine with resolved drift -> no finding", async () => {
    const machine = await makeMachine();
    await recordDrift(machine.id, new Date("2026-01-01T00:00:00Z"), ["curl-extra"]);
    await resolveDrift(machine.id, new Date("2026-01-02T00:00:00Z"));

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("machine with no drift history -> no finding", async () => {
    const machine = await makeMachine();

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("archived machine with open drift -> no finding (gated out as not-live)", async () => {
    const machine = await makeMachine({ state: "archived_restorable" });
    await recordDrift(machine.id, new Date("2026-01-01T00:00:00Z"), ["curl-extra"]);

    const findings = await evaluate();
    expect(findings.find((f) => f.machineId === machine.id)).toBeUndefined();
  });

  test("machine that drifts again after resolution -> finding again", async () => {
    const machine = await makeMachine();
    await recordDrift(machine.id, new Date("2026-01-01T00:00:00Z"), ["curl-extra"]);
    await resolveDrift(machine.id, new Date("2026-01-02T00:00:00Z"));
    await recordDrift(machine.id, new Date("2026-01-03T00:00:00Z"), ["vim-extra"]);

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
    await recordDrift(machine.id, new Date("2026-01-01T00:00:00Z"), ["curl-extra"]);

    const opened = await evaluate();
    const openedFinding = opened.find((f) => f.machineId === machine.id);
    expect(openedFinding).toBeDefined();
    const firstSeenAt = openedFinding?.firstSeenAt;

    await resolveDrift(machine.id, new Date("2026-01-02T00:00:00Z"));
    const resolved = await evaluate();
    expect(resolved.find((f) => f.machineId === machine.id)).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordDrift(machine.id, new Date("2026-01-03T00:00:00Z"), ["vim-extra"]);
    const reopened = await evaluate();
    const reopenedFinding = reopened.find((f) => f.machineId === machine.id);
    expect(reopenedFinding).toBeDefined();
    expect(reopenedFinding?.firstSeenAt.getTime()).not.toBe(firstSeenAt?.getTime());
    expect(reopenedFinding?.firstSeenAt.getTime()).toBeGreaterThan(firstSeenAt?.getTime() ?? 0);
  });
});
