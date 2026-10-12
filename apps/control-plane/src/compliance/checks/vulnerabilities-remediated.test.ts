import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VULNERABILITY_SCAN_SETTING_KEYS as KEYS } from "@cloudable/contracts";
import type * as schema from "@cloudable/schema";
import {
  complianceFindingState,
  machineVulnerabilities,
  machineVulnerabilityScans,
  machines,
  orgs,
  settingValues,
} from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { connectAndMigrate } from "../../test-support/db";
import { isDbReachable } from "../../testing/db-reachable";
import { CHECK_ID, vulnerabilitiesRemediatedCheck } from "./vulnerabilities-remediated";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe.skipIf(!(await isDbReachable(databaseUrl)))(
  "vulnerabilities-remediated check (requires Postgres at DATABASE_URL)",
  () => {
    let db: PostgresJsDatabase<typeof schema>;
    let close: () => Promise<void>;
    const orgIds: string[] = [];

    beforeAll(async () => {
      const conn = await connectAndMigrate(databaseUrl);
      db = conn.db;
      close = conn.close;
    });

    afterAll(async () => {
      if (!close) return;
      if (orgIds.length > 0) {
        const orgMachines = db
          .select({ id: machines.id })
          .from(machines)
          .where(inArray(machines.orgId, orgIds));
        await db
          .delete(machineVulnerabilities)
          .where(inArray(machineVulnerabilities.machineId, orgMachines));
        await db
          .delete(machineVulnerabilityScans)
          .where(inArray(machineVulnerabilityScans.machineId, orgMachines));
        await db
          .delete(complianceFindingState)
          .where(inArray(complianceFindingState.orgId, orgIds));
        await db.delete(settingValues).where(inArray(settingValues.scopeId, orgIds));
        await db.delete(machines).where(inArray(machines.orgId, orgIds));
        await db.delete(orgs).where(inArray(orgs.id, orgIds));
      }
      await close();
    });

    const run = <A>(effect: Effect.Effect<A, never, Db>) =>
      Effect.runPromise(Effect.provide(effect, Layer.succeed(Db, db)));

    async function seedOrg(
      options: { enabled?: boolean; settings?: Record<string, unknown>; enabledAt?: Date } = {},
    ) {
      const [org] = await db
        .insert(orgs)
        .values({ name: `org-${crypto.randomUUID()}` })
        .returning();
      if (!org) throw new Error("seed failed");
      orgIds.push(org.id);
      const values: Record<string, unknown> = {
        ...(options.enabled === false ? {} : { [KEYS.enabled]: true }),
        ...options.settings,
      };
      for (const [key, value] of Object.entries(values)) {
        await db.insert(settingValues).values({
          scopeType: "org",
          scopeId: org.id,
          key,
          value,
          source: "org",
          updatedAt: key === KEYS.enabled ? (options.enabledAt ?? ago(60 * DAY)) : new Date(),
        });
      }
      return org.id;
    }

    async function seedMachine(
      orgId: string,
      options: { state?: "running" | "stopped" | "archived_restorable"; createdAt?: Date } = {},
    ) {
      const [machine] = await db
        .insert(machines)
        .values({
          orgId,
          name: `m-${crypto.randomUUID().slice(0, 8)}`,
          provider: "fake",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          state: options.state ?? "running",
          createdAt: options.createdAt ?? ago(60 * DAY),
        })
        .returning();
      if (!machine) throw new Error("seed failed");
      return machine.id;
    }

    const seedScan = (
      machineId: string,
      options: { finishedAgo: number; dbAgeAtScan?: number | null } = { finishedAgo: 1 * DAY },
    ) => {
      const finishedAt = ago(options.finishedAgo);
      return db.insert(machineVulnerabilityScans).values({
        machineId,
        scanId: crypto.randomUUID(),
        scanner: "trivy",
        scannerVersion: "0.75.0",
        outcome: "completed",
        startedAt: new Date(finishedAt.getTime() - 60_000),
        finishedAt,
        dbBuiltAt:
          options.dbAgeAtScan === null
            ? null
            : new Date(finishedAt.getTime() - (options.dbAgeAtScan ?? 6 * 60 * 60 * 1000)),
        counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      });
    };

    const seedFinding = (
      machineId: string,
      options: {
        id?: string;
        severity: "critical" | "high" | "medium" | "low";
        fixAvailableAgo: number | null;
        resolved?: boolean;
      },
    ) =>
      db.insert(machineVulnerabilities).values({
        machineId,
        vulnerabilityId: options.id ?? `CVE-${crypto.randomUUID().slice(0, 8)}`,
        packageName: "openssl",
        installedVersion: "3.0.2",
        fixedVersion: options.fixAvailableAgo === null ? null : "3.0.3",
        severity: options.severity,
        firstSeenAt: ago((options.fixAvailableAgo ?? 1 * DAY) + DAY),
        lastSeenAt: new Date(),
        fixAvailableSince: options.fixAvailableAgo === null ? null : ago(options.fixAvailableAgo),
        resolvedAt: options.resolved ? new Date() : null,
      });

    const evaluate = (orgId: string) => run(vulnerabilitiesRemediatedCheck.evaluate({ orgId }));
    const reasonsOf = (finding: { detail: Record<string, unknown> }) => finding.detail.reasons;

    test("is a high severity check evidencing vulnerability management", () => {
      expect(vulnerabilitiesRemediatedCheck.id).toBe(CHECK_ID);
      expect(vulnerabilitiesRemediatedCheck.severity).toBe("high");
      expect(vulnerabilitiesRemediatedCheck.controlRefs).toEqual(["vulnerability-management"]);
    });

    test("does not apply while scanning is off, and applies once it is on", async () => {
      const off = await seedOrg({ enabled: false });
      const on = await seedOrg();
      expect(await run(vulnerabilitiesRemediatedCheck.appliesTo({ orgId: off }))).toBe(false);
      expect(await run(vulnerabilitiesRemediatedCheck.appliesTo({ orgId: on }))).toBe(true);
    });

    test("passes for a running machine with a recent scan and nothing overdue", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId);
      await seedFinding(machineId, { severity: "critical", fixAvailableAgo: 2 * DAY });
      expect(await evaluate(orgId)).toEqual([]);
    });

    test("fails for a Critical whose fix has been available longer than 7 days", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId);
      await seedFinding(machineId, {
        id: "CVE-2026-9999",
        severity: "critical",
        fixAvailableAgo: 8 * DAY,
      });

      const findings = await evaluate(orgId);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.machineId).toBe(machineId);
      expect(reasonsOf(findings[0] as never)).toEqual(["fix_overdue"]);
      expect(findings[0]?.detail.overdue).toEqual([
        expect.objectContaining({ vulnerabilityId: "CVE-2026-9999", severity: "critical" }),
      ]);
    });

    test("uses 30 days for a High", async () => {
      const orgId = await seedOrg();
      const fine = await seedMachine(orgId);
      const late = await seedMachine(orgId);
      for (const id of [fine, late]) await seedScan(id);
      await seedFinding(fine, { severity: "high", fixAvailableAgo: 29 * DAY });
      await seedFinding(late, { severity: "high", fixAvailableAgo: 31 * DAY });

      const findings = await evaluate(orgId);
      expect(findings.map((f) => f.machineId)).toEqual([late]);
    });

    test("uses the org's own windows", async () => {
      const orgId = await seedOrg({ settings: { [KEYS.remediationDaysCritical]: 1 } });
      const machineId = await seedMachine(orgId);
      await seedScan(machineId);
      await seedFinding(machineId, { severity: "critical", fixAvailableAgo: 2 * DAY });
      expect(await evaluate(orgId)).toHaveLength(1);
    });

    test("a vulnerability with no fix never fails the check, however old", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId);
      await seedFinding(machineId, { severity: "critical", fixAvailableAgo: null });
      expect(await evaluate(orgId)).toEqual([]);
    });

    test("Medium and Low never fail it, and resolved findings do not count", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId);
      await seedFinding(machineId, { severity: "medium", fixAvailableAgo: 400 * DAY });
      await seedFinding(machineId, { severity: "low", fixAvailableAgo: 400 * DAY });
      await seedFinding(machineId, {
        severity: "critical",
        fixAvailableAgo: 400 * DAY,
        resolved: true,
      });
      expect(await evaluate(orgId)).toEqual([]);
    });

    test("a running machine whose last scan is older than the schedule allows is overdue", async () => {
      const orgId = await seedOrg();
      const ok = await seedMachine(orgId);
      const late = await seedMachine(orgId);
      await seedScan(ok, { finishedAgo: 7 * DAY });
      await seedScan(late, { finishedAgo: 9 * DAY });

      const findings = await evaluate(orgId);
      expect(findings.map((f) => f.machineId)).toEqual([late]);
      expect(reasonsOf(findings[0] as never)).toEqual(["scan_overdue"]);
    });

    test("a daily schedule is overdue much sooner", async () => {
      const orgId = await seedOrg({
        settings: { [KEYS.scanDays]: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
      });
      const machineId = await seedMachine(orgId);
      await seedScan(machineId, { finishedAgo: 3 * DAY });
      expect(reasonsOf((await evaluate(orgId))[0] as never)).toEqual(["scan_overdue"]);
    });

    test("a machine never scanned gets a day from the later of its creation and the switch-on", async () => {
      const orgId = await seedOrg({ enabledAt: ago(10 * DAY) });
      const fresh = await seedMachine(orgId, { createdAt: ago(60 * 60 * 1000) });
      const waiting = await seedMachine(orgId, { createdAt: ago(3 * DAY) });
      const findings = await evaluate(orgId);
      expect(findings.map((f) => f.machineId)).toEqual([waiting]);
      expect(reasonsOf(findings[0] as never)).toEqual(["never_scanned"]);
      expect(fresh).toBeDefined();
    });

    test("switching scanning on starts the clock for old machines too", async () => {
      const orgId = await seedOrg({ enabledAt: ago(60 * 60 * 1000) });
      await seedMachine(orgId, { createdAt: ago(200 * DAY) });
      expect(await evaluate(orgId)).toEqual([]);
    });

    test("a scan against a stale database does not count", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId, { finishedAgo: 1 * DAY, dbAgeAtScan: 10 * DAY });
      expect(reasonsOf((await evaluate(orgId))[0] as never)).toEqual(["database_stale"]);
    });

    test("a stopped machine is not failed for scans it cannot run, but is for an overdue fix", async () => {
      const orgId = await seedOrg();
      const idle = await seedMachine(orgId, { state: "stopped" });
      const exposed = await seedMachine(orgId, { state: "stopped" });
      await seedScan(idle, { finishedAgo: 40 * DAY });
      await seedScan(exposed, { finishedAgo: 40 * DAY });
      await seedFinding(exposed, { severity: "critical", fixAvailableAgo: 20 * DAY });

      const findings = await evaluate(orgId);
      expect(findings.map((f) => f.machineId)).toEqual([exposed]);
      expect(reasonsOf(findings[0] as never)).toEqual(["fix_overdue"]);
    });

    test("an archived machine is out of scope entirely", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId, { state: "archived_restorable" });
      await seedFinding(machineId, { severity: "critical", fixAvailableAgo: 90 * DAY });
      expect(await evaluate(orgId)).toEqual([]);
    });

    test("one finding per machine, with every reason on it", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId, { finishedAgo: 12 * DAY });
      await seedFinding(machineId, { severity: "critical", fixAvailableAgo: 30 * DAY });
      await seedFinding(machineId, { severity: "high", fixAvailableAgo: 60 * DAY });

      const findings = await evaluate(orgId);
      expect(findings).toHaveLength(1);
      expect(reasonsOf(findings[0] as never)).toEqual(["fix_overdue", "scan_overdue"]);
      expect(findings[0]?.detail.overdueFixes).toBe(2);
    });

    test("another org's machines never appear", async () => {
      const mine = await seedOrg();
      const theirs = await seedOrg();
      const theirMachine = await seedMachine(theirs);
      await seedFinding(theirMachine, { severity: "critical", fixAvailableAgo: 90 * DAY });
      expect(await evaluate(mine)).toEqual([]);
      expect(await evaluate(theirs)).toHaveLength(1);
    });

    test("a finding keeps its first-seen time across evaluations, and closes when fixed", async () => {
      const orgId = await seedOrg();
      const machineId = await seedMachine(orgId);
      await seedScan(machineId);
      const [row] = await db
        .insert(machineVulnerabilities)
        .values({
          machineId,
          vulnerabilityId: "CVE-2026-1111",
          packageName: "openssl",
          installedVersion: "3.0.2",
          fixedVersion: "3.0.3",
          severity: "critical",
          firstSeenAt: ago(20 * DAY),
          lastSeenAt: new Date(),
          fixAvailableSince: ago(20 * DAY),
        })
        .returning();

      const first = await evaluate(orgId);
      const second = await evaluate(orgId);
      expect(second[0]?.firstSeenAt.getTime()).toBe(first[0]?.firstSeenAt.getTime() ?? -1);

      await db
        .update(machineVulnerabilities)
        .set({ resolvedAt: new Date() })
        .where(eq(machineVulnerabilities.id, row?.id ?? ""));
      expect(await evaluate(orgId)).toEqual([]);
      const state = await db
        .select()
        .from(complianceFindingState)
        .where(eq(complianceFindingState.orgId, orgId));
      expect(state).toHaveLength(0);
    });
  },
);
