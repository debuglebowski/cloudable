import { machines, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { computeControlMap } from "./control-map";
import { toCsv } from "./csv";
import { evaluateAllChecks } from "./evaluate-all";
import { ageInDays } from "./finding-store";
import { COMPLIANCE_CHECKS } from "./registry";

/**
 * `ComplianceFinding` has no severity field yet — every export stamps this
 * fixed default rather than inventing a per-check severity scheme. Revisit
 * once a real severity model exists.
 */
const DEFAULT_SEVERITY = "medium";

export interface ControlFindingRow {
  readonly controlId: string;
  readonly controlLabel: string;
  readonly framework: string;
  readonly checkId: string;
  readonly checkLabel: string;
  readonly machineId: string | null;
  readonly firstSeenAt: Date;
  readonly ageDays: number;
  readonly severity: string;
  readonly detail: Record<string, unknown>;
}

/**
 * Every currently-open finding, one row per (control, finding) pair —
 * a finding whose check evidences two controls appears once under each,
 * matching the "grouped by control, not by time" evidence model
 * (docs/spec.md §19). Rows are ordered by control, then check, then
 * machine, so the CSV reads as sections without needing blank-line
 * separators.
 */
export const collectOpenFindingsByControl = (
  orgId: string,
): Effect.Effect<ControlFindingRow[], never, Db> =>
  Effect.gen(function* () {
    const controlMap = computeControlMap();
    const evaluations = yield* evaluateAllChecks(orgId);
    const now = new Date();

    const rows: ControlFindingRow[] = [];
    for (const control of controlMap) {
      if (control.evidencedByCheckIds.length === 0) continue;
      for (const evaluation of evaluations) {
        if (!control.evidencedByCheckIds.includes(evaluation.check.id)) continue;
        for (const finding of evaluation.findings) {
          rows.push({
            controlId: control.id,
            controlLabel: control.label,
            framework: control.framework,
            checkId: evaluation.check.id,
            checkLabel: evaluation.check.label,
            machineId: finding.machineId,
            firstSeenAt: finding.firstSeenAt,
            ageDays: ageInDays(finding.firstSeenAt, now),
            severity: DEFAULT_SEVERITY,
            detail: finding.detail,
          });
        }
      }
    }
    return rows;
  });

/** The main evidence export: every open finding, grouped by control, with full detail. */
export const findingsByControlCsv = (rows: readonly ControlFindingRow[]): string =>
  toCsv(
    [
      "control",
      "control_label",
      "framework",
      "check",
      "check_label",
      "machine_id",
      "first_seen_at",
      "open_days",
      "severity",
      "detail",
    ],
    rows.map((row) => [
      row.controlId,
      row.controlLabel,
      row.framework,
      row.checkId,
      row.checkLabel,
      row.machineId,
      row.firstSeenAt.toISOString(),
      row.ageDays,
      row.severity,
      JSON.stringify(row.detail),
    ]),
  );

/** The named "open findings" export (docs/spec.md §19: "Open findings CSV (control, severity, open-since)"). */
export const openFindingsCsv = (rows: readonly ControlFindingRow[]): string =>
  toCsv(
    ["control", "check", "machine_id", "severity", "open_since"],
    rows.map((row) => [
      row.controlId,
      row.checkId,
      row.machineId,
      row.severity,
      row.firstSeenAt.toISOString(),
    ]),
  );

/**
 * The named "asset inventory" export (docs/spec.md §19: "Asset inventory
 * CSV (owner, encryption, drift, patch status)"). Encryption and patch
 * status have no tracked source yet, so both are stubbed; drift status
 * comes from the "no undeclared software" check (unit 8) when it's
 * registered, else reports "unknown" rather than guessing.
 */
export const assetInventoryCsv = (orgId: string): Effect.Effect<string, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const rows = yield* Effect.promise(() =>
      db
        .select({
          id: machines.id,
          name: machines.name,
          state: machines.state,
          ownerEmail: people.email,
        })
        .from(machines)
        .leftJoin(people, eq(machines.ownerPersonId, people.id))
        .where(eq(machines.orgId, orgId)),
    );

    const driftCheck = COMPLIANCE_CHECKS.find((check) => check.id === "no-undeclared-software");
    let driftedMachineIds: ReadonlySet<string> | null = null;
    if (driftCheck) {
      const applies = yield* driftCheck.appliesTo({ orgId });
      const findings = applies ? yield* driftCheck.evaluate({ orgId }) : [];
      driftedMachineIds = new Set(
        findings.flatMap((finding) => (finding.machineId ? [finding.machineId] : [])),
      );
    }

    return toCsv(
      [
        "machine_id",
        "machine_name",
        "owner",
        "state",
        "encryption_status",
        "drift_status",
        "patch_status",
      ],
      rows.map((machine) => [
        machine.id,
        machine.name,
        machine.ownerEmail ?? "unowned",
        machine.state,
        true, // stub: encryption status is not tracked yet.
        driftedMachineIds === null
          ? "unknown"
          : driftedMachineIds.has(machine.id)
            ? "drifted"
            : "clean",
        "unknown", // stub: patch status is not tracked yet.
      ]),
    );
  });
