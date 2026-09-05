import { machines, people, upgradeAttempts } from "@cloudable/schema";
import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../db/layer";
import type { ComplianceSeverity } from "../domain/compliance/types";
import { computeControlMap } from "./control-map";
import { toCsv } from "./csv";
import { evaluateAllChecks } from "./evaluate-all";
import { ageInDays } from "./finding-store";
import { COMPLIANCE_CHECKS } from "./registry";

export interface ControlFindingRow {
  readonly controlId: string;
  readonly controlLabel: string;
  readonly framework: string;
  readonly checkId: string;
  readonly checkLabel: string;
  readonly machineId: string | null;
  readonly firstSeenAt: Date;
  readonly ageDays: number;
  /**
   * Sourced from the check that produced the finding
   * (`ComplianceCheck.severity` — see `domain/compliance/types.ts`), the one
   * place severity is defined. Every finding under the same check shares
   * it; there is no finer-grained per-finding score.
   */
  readonly severity: ComplianceSeverity;
  readonly detail: Record<string, unknown>;
}

/**
 * Every currently-open finding, one row per (control, finding) pair —
 * a finding whose check evidences two controls appears once under each,
 * matching the "grouped by control, not by time" evidence model. Rows are
 * ordered by control, then check, then machine, so the CSV reads as
 * sections without needing blank-line separators.
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
            severity: evaluation.check.severity,
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

/** The named "open findings" export ("Open findings CSV (control, severity, open-since)"). */
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
 * The named "asset inventory" export ("Asset inventory
 * CSV (owner, encryption, drift, patch status)"). Drift status comes from
 * the "no undeclared software" check (unit 8) when it's registered, else
 * reports "unknown" rather than guessing. Encryption and patch status are
 * derived from real, already-tracked facts — `machines.provider` and
 * `upgrade_attempts` — see the inline comments on those two columns below
 * for exactly what each does and does not claim to know.
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
          provider: machines.provider,
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

    // Most recent upgrade attempt per machine (success or failure) — the
    // real, tracked source for patch status below. `upgrade_attempts` is
    // append-only (see its own table comment), so "most recent by
    // `attemptedAt`" is the row that reflects the machine's current image.
    const upgradeRows = yield* Effect.promise(() =>
      db
        .select({
          machineId: upgradeAttempts.machineId,
          outcome: upgradeAttempts.outcome,
        })
        .from(upgradeAttempts)
        .where(eq(upgradeAttempts.orgId, orgId))
        .orderBy(desc(upgradeAttempts.attemptedAt)),
    );
    const latestUpgradeByMachine = new Map<string, (typeof upgradeRows)[number]>();
    for (const row of upgradeRows) {
      if (!latestUpgradeByMachine.has(row.machineId)) {
        latestUpgradeByMachine.set(row.machineId, row);
      }
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
        // Real, not guessed: Azure managed disks are encrypted at rest by
        // Storage Service Encryption unconditionally, and
        // `ProvisioningService.azure.ts` never opts out of it — so any
        // `provider: "azure"` machine really is encrypted at rest. Docker
        // and Fake machines have no such platform guarantee (a Docker
        // container's writable layer is plain host-filesystem storage), so
        // they honestly report "unknown" rather than assume either way.
        machine.provider === "azure" ? "encrypted_at_rest" : "unknown",
        driftedMachineIds === null
          ? "unknown"
          : driftedMachineIds.has(machine.id)
            ? "drifted"
            : "clean",
        // Real, not guessed: reflects the machine's own upgrade-attempt
        // history (`upgrade_attempts`), the only patch-relevant fact this
        // system tracks. This is the *image* patch level (was the last
        // attempt to move to a newer OS image a success), not a live
        // OS-package/apt-security-patch signal — no such per-package
        // telemetry exists anywhere in this build (see
        // `domain/machine/types.ts`'s `MachineReportedState`).
        (() => {
          const latest = latestUpgradeByMachine.get(machine.id);
          if (!latest) return "never_upgraded";
          return latest.outcome === "success" ? "up_to_date" : "upgrade_failed";
        })(),
      ]),
    );
  });
