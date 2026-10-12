import { machines } from "@cloudable/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import {
  latestCompletedScans,
  openFindingsFor,
  toLastCompleted,
} from "../../domain/vulnerability-scan/queries";
import {
  readEnabledSettingUpdatedAt,
  readVulnerabilityScanSettings,
} from "../../domain/vulnerability-scan/settings";
import {
  isDbStale,
  isScanFresh,
  neverScannedGraceEndsAt,
  overdueFixes,
} from "../../domain/vulnerability-scan/status";
import { clearResolvedFindings, upsertFindingFirstSeen } from "../finding-store";

export const CHECK_ID = "vulnerabilities-remediated";

const ARCHIVED_STATES: Array<"archived_restorable" | "archived_expired"> = [
  "archived_restorable",
  "archived_expired",
];

/** How many overdue CVE ids a finding names. The full list is in the vulnerabilities export. */
const OVERDUE_SAMPLE = 10;

export type VulnerabilityFindingReason =
  | "fix_overdue"
  | "scan_overdue"
  | "never_scanned"
  | "database_stale";

/**
 * Check #7 — "Vulnerabilities are fixed on time".
 *
 * One finding per machine, with the reasons it fails in `detail.reasons`. It evidences
 * vulnerability management: that scans happen on schedule against a current database, and that
 * known vulnerabilities with a fix available are fixed inside the window the org set.
 *
 * What makes a machine fail:
 * - `fix_overdue`: a Critical or High vulnerability with a fix available has been open longer
 *   than its window (7 and 30 days by default). The clock starts when a fix first exists, so a
 *   fix published for something found long ago does not read as that long of neglect.
 *   Vulnerabilities with no fix are shown everywhere else but never fail this: there is nothing
 *   the admin can do about them. Medium and Low never fail it either. Applies to every machine
 *   that is not archived, running or not, because the vulnerability is on the disk either way.
 * - `scan_overdue`, `never_scanned`, `database_stale`: the scan itself is not keeping up. These
 *   apply to RUNNING machines only. A stopped machine cannot be scanned, so it is not failed for
 *   it. It scans after its next boot, and `machines-reporting` is the check that notices it has
 *   gone quiet. A machine that has never been scanned gets 24 hours from the later of its
 *   creation and the moment scanning was switched on.
 *
 * Not applicable while scanning is off for the org. Severity is `high`: severity here is per
 * check, not per finding, and an unremediated Critical or High is the most serious thing this
 * product reports.
 *
 * "No findings" is not "no vulnerabilities". The scanner only knows vulnerabilities that are in
 * its database, in operating system packages. A passing check says the process is working.
 */
export const vulnerabilitiesRemediatedCheck: ComplianceCheck = {
  id: CHECK_ID,
  label: "Vulnerabilities are fixed on time",
  severity: "high",
  controlRefs: ["vulnerability-management"],

  appliesTo: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const settings = yield* readVulnerabilityScanSettings(db, orgId).pipe(Effect.orDie);
      return settings.enabled;
    }),

  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const now = new Date();

      const settings = yield* readVulnerabilityScanSettings(db, orgId).pipe(Effect.orDie);
      const enabledSince = yield* readEnabledSettingUpdatedAt(db, orgId).pipe(Effect.orDie);

      const fleet = yield* Effect.tryPromise(() =>
        db
          .select({ id: machines.id, state: machines.state, createdAt: machines.createdAt })
          .from(machines)
          .where(and(eq(machines.orgId, orgId), notInArray(machines.state, ARCHIVED_STATES))),
      ).pipe(Effect.orDie);
      const ids = fleet.map((machine) => machine.id);

      const completed = yield* latestCompletedScans(db, ids).pipe(Effect.orDie);
      const open = yield* openFindingsFor(db, ids).pipe(Effect.orDie);
      const openByMachine = new Map<string, typeof open>();
      for (const row of open) {
        const list = openByMachine.get(row.machineId);
        if (list) list.push(row);
        else openByMachine.set(row.machineId, [row]);
      }

      const findings: ComplianceFinding[] = [];
      const failingMachineIds: string[] = [];

      for (const machine of fleet) {
        const reasons: VulnerabilityFindingReason[] = [];
        const lastScan = toLastCompleted(completed.get(machine.id));
        const overdue = overdueFixes(
          (openByMachine.get(machine.id) ?? []).map((row) => ({
            vulnerabilityId: row.vulnerabilityId,
            severity: row.severity,
            fixedVersion: row.fixedVersion,
            fixAvailableSince: row.fixAvailableSince,
          })),
          settings.remediationDays,
          now,
        );
        if (overdue.length > 0) reasons.push("fix_overdue");

        if (machine.state === "running") {
          if (lastScan) {
            if (!isScanFresh(lastScan, settings.scanDays, now)) reasons.push("scan_overdue");
            else if (isDbStale(lastScan)) reasons.push("database_stale");
          } else {
            const since = new Date(
              Math.max(machine.createdAt.getTime(), enabledSince?.getTime() ?? 0),
            );
            if (now.getTime() > neverScannedGraceEndsAt(since).getTime()) {
              reasons.push("never_scanned");
            }
          }
        }

        if (reasons.length === 0) continue;

        failingMachineIds.push(machine.id);
        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: CHECK_ID,
          orgId,
          machineId: machine.id,
          detailKey: machine.id,
        }).pipe(Effect.orDie);

        findings.push({
          checkId: CHECK_ID,
          orgId,
          machineId: machine.id,
          firstSeenAt,
          detail: {
            reasons,
            lastScanAt: lastScan ? lastScan.finishedAt.toISOString() : null,
            dbBuiltAt: lastScan?.dbBuiltAt ? lastScan.dbBuiltAt.toISOString() : null,
            remediationDays: settings.remediationDays,
            overdueFixes: overdue.length,
            overdue: overdue.slice(0, OVERDUE_SAMPLE),
          },
        });
      }

      yield* clearResolvedFindings(CHECK_ID, orgId, failingMachineIds).pipe(Effect.orDie);
      return findings;
    }),
};
