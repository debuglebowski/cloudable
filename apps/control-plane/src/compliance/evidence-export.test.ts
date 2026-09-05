import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { complianceFindingState, machines, orgs, people, upgradeAttempts } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../db/layer";
import { connectTestDb } from "../test-support/db";
import {
  type ControlFindingRow,
  assetInventoryCsv,
  collectOpenFindingsByControl,
  findingsByControlCsv,
  openFindingsCsv,
} from "./evidence-export";

/** `.returning()` always yields exactly one row for a single-row insert. */
function mustFirst<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected at least one row");
  return row;
}

const sampleRows: ControlFindingRow[] = [
  {
    controlId: "access-management",
    controlLabel: "Access management",
    framework: "ISO 27001 A.9",
    checkId: "access-revoked-on-offboarding",
    checkLabel: "Access revoked on offboarding",
    machineId: "machine-1",
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    ageDays: 3,
    severity: "high",
    detail: { certificateId: "cert-1" },
  },
  {
    controlId: "asset-management",
    controlLabel: "Asset management",
    framework: "ISO 27001 A.8",
    checkId: "machines-reporting",
    checkLabel: "Machines are reporting",
    machineId: "machine-2",
    firstSeenAt: new Date("2026-01-02T00:00:00Z"),
    ageDays: 1,
    severity: "low",
    detail: { lastVerifiedAt: null },
  },
];

describe("evidence-export CSVs (pure rendering)", () => {
  test("findingsByControlCsv keeps a stable column shape and renders each row's own severity", () => {
    const csv = findingsByControlCsv(sampleRows);
    const [header, ...lines] = csv.trim().split("\r\n");

    expect(header).toBe(
      "control,control_label,framework,check,check_label,machine_id,first_seen_at,open_days,severity,detail",
    );
    expect(lines).toHaveLength(2);
    // The two rows' severities differ — sourced per-check, not one constant
    // stamped onto every row (what this unit replaces).
    expect(lines[0]).toContain(",high,");
    expect(lines[1]).toContain(",low,");
  });

  test("openFindingsCsv keeps a stable column shape and renders each row's own severity", () => {
    const csv = openFindingsCsv(sampleRows);
    const [header, ...lines] = csv.trim().split("\r\n");

    expect(header).toBe("control,check,machine_id,severity,open_since");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(",high,");
    expect(lines[1]).toContain(",low,");
  });
});

describe("evidence-export (live DB)", () => {
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
      if (!orgId) continue;
      // Dependency order: complianceFindingState/upgradeAttempts/machines/people
      // reference (or are scoped to) the org, so they're cleared before the org
      // row itself. Never touches `events` — nothing here writes to it.
      await db.delete(complianceFindingState).where(eq(complianceFindingState.orgId, orgId));
      await db.delete(upgradeAttempts).where(eq(upgradeAttempts.orgId, orgId));
      await db.delete(machines).where(eq(machines.orgId, orgId));
      await db.delete(people).where(eq(people.orgId, orgId));
      await db.delete(orgs).where(eq(orgs.id, orgId));
    }
  });

  const freshOrg = async () => {
    const org = mustFirst(await db.insert(orgs).values({ name: "Acme" }).returning());
    testOrgIds.push(org.id);
    return org.id;
  };

  test("collectOpenFindingsByControl sources severity per-check, not one constant for every row", async () => {
    const orgId = await freshOrg();

    // Machine A: no owner -> triggers `active-owner` (severity "medium").
    // lastVerifiedAt is fresh so it doesn't also trigger `machines-reporting`.
    await db.insert(machines).values({
      orgId,
      ownerPersonId: null,
      name: "no-owner",
      provider: "fake",
      region: "eastus",
      sizeSku: "Standard_B2s",
      image: "ubuntu-24.04",
      state: "running",
      lastVerifiedAt: new Date(),
    });

    // Machine B: owned by an active person, but hasn't reported in well over
    // the 5-minute staleness threshold -> triggers `machines-reporting`
    // (severity "low"), not `active-owner`.
    const owner = mustFirst(
      await db
        .insert(people)
        .values({ orgId, email: `${crypto.randomUUID()}@acme.test`, active: true })
        .returning(),
    );
    await db.insert(machines).values({
      orgId,
      ownerPersonId: owner.id,
      name: "stale",
      provider: "fake",
      region: "eastus",
      sizeSku: "Standard_B2s",
      image: "ubuntu-24.04",
      state: "running",
      lastVerifiedAt: new Date(Date.now() - 10 * 60_000),
    });

    const rows = await Effect.runPromise(
      Effect.provide(collectOpenFindingsByControl(orgId), Layer.succeed(Db, db)),
    );

    const activeOwnerRow = rows.find((row) => row.checkId === "active-owner");
    const reportingRow = rows.find((row) => row.checkId === "machines-reporting");

    expect(activeOwnerRow?.severity).toBe("medium");
    expect(reportingRow?.severity).toBe("low");
    // The whole point of this unit: two findings from two different checks
    // carry two different severities, not the same fixed default.
    expect(activeOwnerRow?.severity).not.toBe(reportingRow?.severity);
  });

  test("assetInventoryCsv derives encryption_status from provider and patch_status from upgrade history", async () => {
    const orgId = await freshOrg();

    // Fake machine, never upgraded: no platform encryption guarantee, and no
    // upgrade_attempts row at all.
    const neverUpgraded = mustFirst(
      await db
        .insert(machines)
        .values({
          orgId,
          ownerPersonId: null,
          name: "asset-fake",
          provider: "fake",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          state: "running",
          lastVerifiedAt: new Date(),
        })
        .returning(),
    );

    // Azure machine, most recent upgrade attempt succeeded.
    const upToDate = mustFirst(
      await db
        .insert(machines)
        .values({
          orgId,
          ownerPersonId: null,
          name: "asset-azure",
          provider: "azure",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          state: "running",
          lastVerifiedAt: new Date(),
        })
        .returning(),
    );
    await db.insert(upgradeAttempts).values({
      orgId,
      machineId: upToDate.id,
      previousImage: "ubuntu-22.04",
      targetImage: "ubuntu-24.04",
      outcome: "success",
      backoffMs: 1000,
      attemptedAt: new Date(Date.now() - 1000),
      nextEligibleAt: new Date(Date.now() + 1000),
    });

    // Fake machine whose most recent upgrade attempt failed and rolled back —
    // still on its previous image.
    const upgradeFailed = mustFirst(
      await db
        .insert(machines)
        .values({
          orgId,
          ownerPersonId: null,
          name: "asset-failed",
          provider: "fake",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-22.04",
          state: "running",
          lastVerifiedAt: new Date(),
        })
        .returning(),
    );
    await db.insert(upgradeAttempts).values({
      orgId,
      machineId: upgradeFailed.id,
      previousImage: "ubuntu-22.04",
      targetImage: "ubuntu-24.04",
      outcome: "rolled_back",
      backoffMs: 1000,
      attemptedAt: new Date(Date.now() - 1000),
      nextEligibleAt: new Date(Date.now() + 1000),
    });

    const csv = await Effect.runPromise(
      Effect.provide(assetInventoryCsv(orgId), Layer.succeed(Db, db)),
    );
    const [header, ...lines] = csv.trim().split("\r\n");

    expect(header).toBe(
      "machine_id,machine_name,owner,state,encryption_status,drift_status,patch_status",
    );
    expect(lines).toHaveLength(3);

    const line = (machineId: string) => lines.find((l) => l?.startsWith(`${machineId},`));
    expect(line(neverUpgraded.id)).toContain(",unknown,");
    expect(line(neverUpgraded.id)?.endsWith(",never_upgraded")).toBe(true);
    expect(line(upToDate.id)).toContain(",encrypted_at_rest,");
    expect(line(upToDate.id)?.endsWith(",up_to_date")).toBe(true);
    expect(line(upgradeFailed.id)).toContain(",unknown,");
    expect(line(upgradeFailed.id)?.endsWith(",upgrade_failed")).toBe(true);
  });
});
