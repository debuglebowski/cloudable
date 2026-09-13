// ---------------------------------------------------------------------------
// `cloudable compliance *` and `cloudable export *` — the auditor's surface.
//
// Checks, not tests. Each of the six checks reads the append-only event log and
// maps to the controls it evidences (docs/compliance.md). An override records
// that a control is met by something outside this system; it does not change
// what the events say.
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import { oneOf, parseArgs, readSpec, required } from "./args";
import { UsageError } from "./errors";
import { authenticatedApiRequest, authenticatedApiText, patchJson, query } from "./http-client";
import { currentIdentity } from "./identity";
import { dash, printEmpty, printJson, printTable } from "./output";

const CONTROL_STATUSES = ["implemented", "manual_action_required", "not_covered"] as const;

interface Finding {
  machineId: string | null;
  firstSeenAt: string;
  ageDays: number;
  detail: Record<string, unknown>;
}

interface CheckResult {
  checkId: string;
  label: string;
  controlRefs: ReadonlyArray<string>;
  status: "pass" | "fail" | "not_applicable";
  severity: "low" | "medium" | "high";
  findings: ReadonlyArray<Finding>;
  medianAgeDays: number | null;
}

interface ControlMapEntry {
  id: string;
  label: string;
  framework: string;
  status: (typeof CONTROL_STATUSES)[number];
  evidencedByCheckIds: ReadonlyArray<string>;
  overridden: boolean;
  overridable: boolean;
}

export async function runComplianceChecksCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const { orgId } = await currentIdentity();
  const res = await authenticatedApiRequest<{ controls: ControlMapEntry[] }>(
    `/api/v1/compliance/control-map${query({ orgId })}`,
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.controls.length === 0) {
    printEmpty("controls");
    return;
  }
  printTable(
    ["control", "framework", "status", "evidenced by", "override"],
    res.controls.map((control) => [
      control.id,
      control.framework,
      control.status,
      control.evidencedByCheckIds.length === 0 ? dash(null) : control.evidencedByCheckIds.join(","),
      control.overridden ? "yes" : control.overridable ? "—" : "not allowed",
    ]),
  );
}

export async function runComplianceFindingsCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ booleans: ["csv"] }));
  const { orgId } = await currentIdentity();

  if (args.booleans.has("csv")) {
    process.stdout.write(
      await authenticatedApiText(`/api/v1/compliance/findings/export${query({ orgId })}`),
    );
    return;
  }

  const res = await authenticatedApiRequest<{
    orgId: string;
    generatedAt: string;
    checks: CheckResult[];
  }>(`/api/v1/compliance/findings${query({ orgId })}`);
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }

  printTable(
    ["check", "status", "severity", "findings", "median age", "controls"],
    res.checks.map((check) => [
      check.checkId,
      check.status,
      check.severity,
      String(check.findings.length),
      check.medianAgeDays === null ? dash(null) : `${check.medianAgeDays}d`,
      check.controlRefs.join(","),
    ]),
  );

  const failing = res.checks.filter((check) => check.status === "fail");
  for (const check of failing) {
    console.log(`\n${check.checkId} — ${check.label}`);
    printTable(
      ["machine", "first seen", "age", "detail"],
      check.findings.map((finding) => [
        dash(finding.machineId),
        finding.firstSeenAt.slice(0, 10),
        `${finding.ageDays}d`,
        JSON.stringify(finding.detail),
      ]),
    );
  }
  if (failing.length > 0) process.exitCode = 1;
}

export async function runComplianceOverrideCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = `usage: cloudable compliance override <controlId> --status ${CONTROL_STATUSES.join("|")} | --clear`;
  const args = parseArgs(argv, readSpec({ values: ["status"], booleans: ["clear"] }));
  const controlId = required(args, 0, "a control id", usage);
  const clear = args.booleans.has("clear");
  if (clear === (args.flags.status !== undefined)) {
    throw new UsageError(`pass exactly one of --status or --clear\n\n${usage}`);
  }
  const status = clear ? null : oneOf(args.flags.status ?? "", CONTROL_STATUSES, "status");
  const { orgId } = await currentIdentity();

  const res = await authenticatedApiRequest<{ controls: ControlMapEntry[] }>(
    `/api/v1/compliance/control-map/${encodeURIComponent(controlId)}/override`,
    patchJson({ orgId, status }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  const control = res.controls.find((entry) => entry.id === controlId);
  console.log(
    clear
      ? `Override cleared. ${controlId} is back to ${control?.status ?? "its computed status"}.`
      : `${controlId} is now reported as ${status}.`,
  );
}

/** `--output <path>` writes the file; without it the CSV goes to stdout for a pipe. */
async function exportCsv(
  argv: ReadonlyArray<string>,
  path: string,
  defaultName: string,
): Promise<void> {
  const args = parseArgs(argv, { values: ["output"] });
  const { orgId } = await currentIdentity();
  const csv = await authenticatedApiText(`${path}${query({ orgId })}`);

  const output = args.flags.output;
  if (output === undefined) {
    process.stdout.write(csv);
    return;
  }
  const target = output.endsWith("/") ? `${output}${defaultName}` : output;
  fs.writeFileSync(target, csv, "utf8");
  console.log(`Wrote ${target} (${csv.split("\n").length - 1} rows).`);
}

export const runExportAssetInventoryCommand = (argv: ReadonlyArray<string>) =>
  exportCsv(argv, "/api/v1/compliance/exports/asset-inventory.csv", "asset-inventory.csv");

export const runExportFindingsCommand = (argv: ReadonlyArray<string>) =>
  exportCsv(argv, "/api/v1/compliance/exports/findings.csv", "findings.csv");
