import type {
  UpdateVulnerabilityScanRequest,
  VulnerabilityScanOrgView,
} from "@cloudable/contracts";
// ---------------------------------------------------------------------------
// `cloudable org *` — org-wide settings and the org layer of the package
// manifest.
//
// These are the defaults every machine inherits (docs/inheritance.md): change
// one here and it resolves down to every machine that has no override of its
// own. Nothing here touches a live machine; the agent picks changes up on its
// next reconcile.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, positiveInt, readSpec } from "./args";
import { UsageError } from "./errors";
import { authenticatedApiRequest, patchJson, postJson } from "./http-client";
import { type OrgWire, fetchOrg } from "./identity";
import { packageEdits } from "./machines";
import { dash, printEmpty, printFields, printJson, printTable } from "./output";
import { usageFor } from "./program";
import {
  VULNERABILITY_SCAN_USAGE,
  VULNERABILITY_SCAN_VALUE_FLAGS,
  describeSwitch,
  hasVulnerabilityScanChanges,
  printVulnerabilityScanView,
  vulnerabilityScanUpdateFromArgs,
} from "./vulnerability-scan";

const APPROVAL_ACTIONS = [
  "snapshot_restore",
  "break_glass",
  "admin_access",
  "offboarding",
  "package_install",
] as const;
const APPROVAL_MODES = ["none", "single", "dual"] as const;
const RETENTION_LOCATIONS = ["customer", "cloudable_sweden_central"] as const;

interface OrgPackageEntry {
  packageName: string;
  versionPin: string | null;
  pinned: boolean;
  partOf?: string | null;
}

/** "1 machine overrides it", not "1 machines override it". */
function overrideNote(count: number): string {
  if (count === 0) return "";
  return count === 1 ? " (1 machine overrides it)" : ` (${count} machines override it)`;
}

function printOrg(org: OrgWire): void {
  printFields([
    ["name", org.name],
    ["id", org.id],
    ["logging tier", `${org.loggingTier}${overrideNote(org.loggingTierOverrideCount)}`],
    ["snapshot retention", `${org.retentionDefaultDays} days`],
    ["event retention", `${org.eventRetentionDays} days`],
    ["retention location", org.retentionLocation],
  ]);
  console.log("\napproval modes:");
  printTable(
    ["action", "mode"],
    APPROVAL_ACTIONS.map((action) => [action, dash(org.approvalModes[action])]),
  );
}

export async function runOrgGetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const org = await fetchOrg();
  if (args.booleans.has("json")) {
    printJson(org);
    return;
  }
  printOrg(org);
}

/** `--approval-mode snapshot_restore=dual`, repeatable. */
function approvalModes(values: ReadonlyArray<string>): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const value of values) {
    const [action, mode] = value.split("=");
    if (!action || !mode) {
      throw new UsageError(`--approval-mode wants <action>=<mode>, got '${value}'`);
    }
    oneOf(action, APPROVAL_ACTIONS, "approval-mode");
    oneOf(mode, APPROVAL_MODES, "approval-mode");
    modes[action] = mode;
  }
  return modes;
}

export async function runOrgUpdateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    `org update [--name <name>] [--logging-tier 1|2] [--retention-days <n>] [--event-retention-days <n>] [--retention-location customer|cloudable_sweden_central] [--approval-mode <action>=<mode> --reason <text>] ${VULNERABILITY_SCAN_USAGE}`,
  );
  const args = parseArgs(
    argv,
    readSpec({
      values: [
        "name",
        "logging-tier",
        "retention-days",
        "event-retention-days",
        "retention-location",
        "reason",
        ...VULNERABILITY_SCAN_VALUE_FLAGS,
      ],
      repeatable: ["approval-mode"],
    }),
  );

  const modes = approvalModes(args.all["approval-mode"] ?? []);
  const payload: Record<string, unknown> = {};
  if (args.flags.name) payload.name = args.flags.name;
  if (args.flags["logging-tier"]) {
    payload.loggingTier = Number(oneOf(args.flags["logging-tier"], ["1", "2"], "logging-tier"));
  }
  if (args.flags["retention-days"]) {
    payload.retentionDefaultDays = positiveInt(args.flags["retention-days"], "retention-days");
  }
  if (args.flags["event-retention-days"]) {
    // The control plane enforces the 90-day floor and says so; this only rejects
    // what is not a whole number at all.
    payload.eventRetentionDays = positiveInt(
      args.flags["event-retention-days"],
      "event-retention-days",
    );
  }
  if (args.flags["retention-location"]) {
    payload.retentionLocation = oneOf(
      args.flags["retention-location"],
      RETENTION_LOCATIONS,
      "retention-location",
    );
  }
  // Approval modes change only with an approver's sign-off, so they are a request of their
  // own, not part of the PATCH. Checked before anything is sent.
  const changesModes = Object.keys(modes).length > 0;
  const reason = args.flags.reason?.trim();
  if (changesModes && !reason) {
    throw new UsageError(`--approval-mode needs --reason: an approver reads it\n\n${usage}`);
  }

  // Parsed (and refused if invalid) before anything is sent, so a typo in a scanning flag
  // cannot leave a half-applied change behind.
  const scan: UpdateVulnerabilityScanRequest = vulnerabilityScanUpdateFromArgs(args);
  const changesScan = hasVulnerabilityScanChanges(scan);

  if (Object.keys(payload).length === 0 && !changesScan && !changesModes) {
    throw new UsageError(`nothing to change\n\n${usage}`);
  }

  // Scanning lives on its own endpoint, so it is one PATCH of its own. Organisation settings
  // keep the one they always had. Each is recorded server side as setting changes.
  const org =
    Object.keys(payload).length > 0
      ? await authenticatedApiRequest<OrgWire>("/api/v1/organisation", patchJson(payload))
      : undefined;
  const scanView = changesScan
    ? await authenticatedApiRequest<VulnerabilityScanOrgView>(
        "/api/v1/vulnerability-scan",
        patchJson(scan),
      )
    : undefined;

  const modeRequest = changesModes
    ? await authenticatedApiRequest<{ id: string; status: string }>(
        "/api/v1/organisation/approval-modes",
        postJson({ approvalModes: modes, reason }),
      )
    : undefined;

  if (args.booleans.has("json")) {
    // One result keeps its own shape; more than one are named so none is ambiguous.
    const parts = {
      organisation: org,
      vulnerabilityScan: scanView,
      approvalModesRequest: modeRequest,
    };
    const present = Object.entries(parts).filter(([, value]) => value !== undefined);
    printJson(present.length === 1 ? present[0]?.[1] : Object.fromEntries(present));
    return;
  }
  if (modeRequest) {
    console.log(
      `Approval mode change requested (approval ${modeRequest.id}). It applies once an approver signs off.`,
    );
    if (org || scanView) console.log("");
  }
  if (org) printOrg(org);
  if (scanView) {
    if (org) console.log("");
    const note = describeSwitch(scan);
    if (note) console.log(`${note}\n`);
    printVulnerabilityScanView(scanView);
  }
}

export async function runOrgPackagesListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const res = await authenticatedApiRequest<{ items: OrgPackageEntry[] }>(
    "/api/v1/organisation/packages",
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.items.length === 0) {
    printEmpty("org packages");
    return;
  }
  printTable(
    ["package", "version", "pinned", "part of"],
    res.items.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.pinned ? "yes" : "no",
      dash(entry.partOf ?? null),
    ]),
  );
}

export async function runOrgPackagesSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "org packages set [--add <pkg>[@<version>]] [--pin <pkg>[@<version>]] [--remove <pkg>] [--part-of <parent>] [--standalone <pkg>]\n\n<pkg> is an apt name, or npm:<name>, pipx:<name>, cargo:<name>, home:<name>.",
  );
  const args = parseArgs(
    argv,
    readSpec({ values: ["part-of"], repeatable: ["add", "pin", "remove", "standalone"] }),
  );
  const { upserts, removals } = packageEdits(args);
  if (upserts.length === 0 && removals.length === 0) {
    throw new UsageError(`nothing to change\n\n${usage}`);
  }

  const res = await authenticatedApiRequest<{ items: OrgPackageEntry[] }>(
    "/api/v1/organisation/packages",
    patchJson({
      ...(upserts.length > 0 ? { upserts } : {}),
      ...(removals.length > 0 ? { removals } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  console.log("Org manifest updated. Every machine inherits it on its next reconcile.");
  printTable(
    ["package", "version", "pinned", "part of"],
    res.items.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.pinned ? "yes" : "no",
      dash(entry.partOf ?? null),
    ]),
  );
}
