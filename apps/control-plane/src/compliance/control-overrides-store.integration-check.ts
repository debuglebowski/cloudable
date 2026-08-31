import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { orgs } from "@cloudable/schema";
import { Effect, Layer } from "effect";
import { startTestDb } from "../../test/testcontainers";
import { Db } from "../db/layer";
import { OVERRIDABLE_CONTROL_IDS, applyControlOverrides, computeControlMap } from "./control-map";
import {
  UnknownControlError,
  clearControlOverride,
  loadControlOverrides,
  setControlOverride,
} from "./control-overrides-store";

/** `.returning()` always yields exactly one row for a single-row insert. */
function mustFirst<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected at least one row");
  return row;
}

describe("control overrides (docs/spec.md §19: org-level, overridable per control)", () => {
  let db: Awaited<ReturnType<typeof startTestDb>>["db"];
  let stop: Awaited<ReturnType<typeof startTestDb>>["stop"];
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    const testDb = await startTestDb();
    db = testDb.db;
    stop = testDb.stop;

    orgAId = mustFirst(await db.insert(orgs).values({ name: "Org A" }).returning()).id;
    orgBId = mustFirst(await db.insert(orgs).values({ name: "Org B" }).returning()).id;
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  const runWithDb = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.runPromise(Effect.provide(effect, Layer.succeed(Db, db)));

  const controlMapFor = (orgId: string) =>
    runWithDb(
      Effect.gen(function* () {
        const overrides = yield* loadControlOverrides(orgId);
        return applyControlOverrides(computeControlMap(), overrides);
      }),
    );

  test("with no override, a control's status matches the computed default exactly", async () => {
    const defaultMap = computeControlMap();
    const map = await controlMapFor(orgAId);

    expect(map).toEqual(
      defaultMap.map((entry) => ({
        ...entry,
        overridden: false,
        overridable: OVERRIDABLE_CONTROL_IDS.has(entry.id),
      })),
    );
    const assetManagement = map.find((c) => c.id === "asset-management");
    expect(assetManagement?.overridden).toBe(false);
    expect(assetManagement?.status).toBe(
      defaultMap.find((c) => c.id === "asset-management")?.status,
    );
  });

  test("an override set for org A is isolated from org B", async () => {
    // `computeControlMap()` with no args uses the real `COMPLIANCE_CHECKS` registry —
    // asset-management already has registered checks evidencing it
    // (retention-honoured, machines-reporting, no-undeclared-software), so its real
    // default is "implemented". Computed dynamically here (not hardcoded) so this test
    // stays correct however the registry changes as more units land.
    const defaultStatus = computeControlMap().find((c) => c.id === "asset-management")?.status;
    const overrideStatus = defaultStatus === "implemented" ? "not_covered" : "implemented";

    await runWithDb(setControlOverride(orgAId, "asset-management", overrideStatus));

    const orgAMap = await controlMapFor(orgAId);
    const orgAEntry = orgAMap.find((c) => c.id === "asset-management");
    expect(orgAEntry?.status).toBe(overrideStatus);
    expect(orgAEntry?.overridden).toBe(true);

    // Org B never had an override set — it must still see the computed
    // default, not org A's override leaking across the tenant boundary.
    const orgBMap = await controlMapFor(orgBId);
    const orgBEntry = orgBMap.find((c) => c.id === "asset-management");
    expect(orgBEntry?.status).toBe(defaultStatus);
    expect(orgBEntry?.overridden).toBe(false);
  });

  test("setting an override twice replaces it rather than accumulating", async () => {
    await runWithDb(setControlOverride(orgAId, "access-management", "not_covered"));
    await runWithDb(setControlOverride(orgAId, "access-management", "implemented"));

    const overrides = await runWithDb(loadControlOverrides(orgAId));
    const accessManagementOverrides = overrides.filter((o) => o.controlId === "access-management");
    expect(accessManagementOverrides).toHaveLength(1);
    expect(accessManagementOverrides[0]?.status).toBe("implemented");
  });

  test("an out-of-scope control (docs/compliance.md: 'must not be claimed as evidenced') is not overridable at all", async () => {
    const result = await runWithDb(
      setControlOverride(orgAId, "hr-screening", "implemented").pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnknownControlError);
    }

    const overrides = await runWithDb(loadControlOverrides(orgAId));
    expect(overrides.some((o) => o.controlId === "hr-screening")).toBe(false);
  });

  test("clearing an override reverts the control to its computed default", async () => {
    const defaultStatus = computeControlMap().find((c) => c.id === "asset-management")?.status;
    await runWithDb(setControlOverride(orgAId, "asset-management", "not_covered"));

    let entry = (await controlMapFor(orgAId)).find((c) => c.id === "asset-management");
    expect(entry?.status).toBe("not_covered");
    expect(entry?.overridden).toBe(true);

    await runWithDb(clearControlOverride(orgAId, "asset-management"));

    entry = (await controlMapFor(orgAId)).find((c) => c.id === "asset-management");
    expect(entry?.status).toBe(defaultStatus);
    expect(entry?.overridden).toBe(false);
  });

  test("setting an override for an unknown control id fails, not silently accepted", async () => {
    const result = await runWithDb(
      setControlOverride(orgAId, "not-a-real-control", "implemented").pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnknownControlError);
    }

    const overrides = await runWithDb(loadControlOverrides(orgAId));
    expect(overrides.some((o) => o.controlId === "not-a-real-control")).toBe(false);
  });

  test("clearing an override for an unknown control id fails the same way", async () => {
    const result = await runWithDb(
      clearControlOverride(orgAId, "not-a-real-control").pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(UnknownControlError);
    }
  });
});
