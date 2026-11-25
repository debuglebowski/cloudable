import type {
  PackageEnsureApprovalView,
  PackageSetting,
  UpdateVulnerabilityScanRequest,
  VulnerabilityScanOrgView,
} from "@cloudable/contracts";
// ---------------------------------------------------------------------------
// `cloudable org *` — org-wide settings and the org layer of the package
// manifest.
//
// These are the defaults every machine inherits (docs/inheritance.md): change
// one here and it resolves down to every machine that has no override of its
// own. Nothing here touches a live machine. A package set to Ensure is
// installed by the control plane on each machine's next report, once the
// setting is approved.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, positiveInt, readSpec } from "./args";
import { UsageError } from "./errors";
import { authenticatedApiRequest, patchJson, postJson } from "./http-client";
import { type OrgWire, fetchOrg } from "./identity";
import {
  PACKAGE_EDIT_FLAGS,
  describeEnsureApprovals,
  packageEdits,
  settingLabel,
} from "./machines";
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
  "package_ensure",
  "apt_repository",
] as const;
const APPROVAL_MODES = ["none", "single", "dual"] as const;
const RETENTION_LOCATIONS = ["customer", "cloudable_sweden_central"] as const;

interface OrgPackageEntry {
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  partOf?: string | null;
  description?: string | null;
  setting?: PackageSetting;
}

interface OrgPackagesResponse {
  items: OrgPackageEntry[];
  ensureApprovals?: PackageEnsureApprovalView[];
}

function printOrgPackages(items: ReadonlyArray<OrgPackageEntry>): void {
  printTable(
    ["package", "version", "locked", "setting", "part of", "description"],
    items.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.locked ? "yes" : "no",
      settingLabel(entry.setting),
      dash(entry.partOf ?? null),
      dash(entry.description ?? null),
    ]),
  );
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
    [
      "ensure retry wait",
      org.ensureRetryHours === undefined ? "-" : `${org.ensureRetryHours} hours`,
    ],
    ["nix snapshot", org.nixSnapshot ?? "-"],
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
    `org update [--name <name>] [--logging-tier 1|2] [--retention-days <n>] [--event-retention-days <n>] [--retention-location customer|cloudable_sweden_central] [--ensure-retry-hours <n>] [--nix-snapshot <commit>|none] [--approval-mode <action>=<mode> --reason <text>] ${VULNERABILITY_SCAN_USAGE}`,
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
        "ensure-retry-hours",
        "nix-snapshot",
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
  if (args.flags["ensure-retry-hours"]) {
    // The control plane enforces 1 to 720 and says so; this only rejects what is
    // not a whole number at all.
    payload.ensureRetryHours = positiveInt(args.flags["ensure-retry-hours"], "ensure-retry-hours");
  }
  if (args.flags["nix-snapshot"]) {
    // "none" clears it. The control plane checks it is a full nixpkgs commit and says so.
    const snapshot = args.flags["nix-snapshot"].trim();
    payload.nixSnapshot = snapshot === "none" ? null : snapshot;
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
  const res = await authenticatedApiRequest<OrgPackagesResponse>("/api/v1/organisation/packages");
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.items.length === 0) {
    printEmpty("org packages");
    return;
  }
  printOrgPackages(res.items);
}

export async function runOrgPackagesSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "org packages set [--add <pkg>[@<version>]] [--lock <pkg>[@<version>]] [--remove <pkg>] [--part-of <parent>] [--description <text>] [--standalone <pkg>] [--ensure <pkg>] [--ensure-latest <pkg>] [--allow <pkg>]\n\n<pkg> is an apt name, or npm:<name>, pipx:<name>, cargo:<name>, home:<name>. Only apt packages can be ensured.",
  );
  const args = parseArgs(
    argv,
    readSpec({
      values: ["part-of", "description"],
      repeatable: [...PACKAGE_EDIT_FLAGS],
    }),
  );
  const { upserts, removals } = packageEdits(args);
  if (upserts.length === 0 && removals.length === 0) {
    throw new UsageError(`nothing to change\n\n${usage}`);
  }

  const res = await authenticatedApiRequest<OrgPackagesResponse>(
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
  console.log("Org manifest updated. Every machine without its own entry inherits it.");
  for (const line of describeEnsureApprovals(res.ensureApprovals ?? [], upserts)) console.log(line);
  printOrgPackages(res.items);
}

// ---------------------------------------------------------------------------
// org repos: approved apt repositories beyond Ubuntu's own. Adding or removing
// one waits for an `apt_repository` approval.
// ---------------------------------------------------------------------------

interface AptRepositoryWire {
  id: string;
  name: string;
  url: string;
  suite: string;
  components: string[];
  fingerprint: string;
  addedAt: string;
  removedAt: string | null;
}

interface AptRepositoryChangeWire {
  approvalId: string;
  status: string;
  fingerprint?: string;
}

function describeRepoChange(res: AptRepositoryChangeWire): string {
  return res.status === "approved"
    ? "Done. Machines pick it up on their next check-in."
    : `Approval requested (${res.approvalId}). Nothing changes until an approver signs it off.`;
}

export async function runOrgReposListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const res = await authenticatedApiRequest<{ items: AptRepositoryWire[] }>(
    "/api/v1/organisation/apt-repositories",
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.items.length === 0) {
    printEmpty("apt repositories");
    return;
  }
  printTable(
    ["name", "source", "signing key", "status", "id"],
    res.items.map((r) => [
      r.name,
      `${r.url} ${r.suite} ${r.components.join(" ")}`,
      r.fingerprint,
      r.removedAt ? `removed ${r.removedAt.slice(0, 10)}` : "active",
      r.id,
    ]),
  );
}

export async function runOrgReposAddCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "org repos add --name <name> --url <https-url> --suite <suite> [--components <c1,c2>] --key-file <path|-> --reason <text>",
  );
  const args = parseArgs(
    argv,
    readSpec({ values: ["name", "url", "suite", "components", "key-file", "reason"] }),
  );
  for (const flag of ["name", "url", "suite", "key-file", "reason"]) {
    if (!args.flags[flag]) throw new UsageError(`--${flag} is required\n\n${usage}`);
  }
  const keyFile = args.flags["key-file"] ?? "";
  const signingKey =
    keyFile === "-"
      ? await Bun.stdin.text()
      : await Bun.file(keyFile)
          .text()
          .catch(() => "");
  if (signingKey.trim() === "") throw new UsageError(`could not read a key from ${keyFile}`);
  const res = await authenticatedApiRequest<AptRepositoryChangeWire>(
    "/api/v1/organisation/apt-repositories",
    postJson({
      name: args.flags.name,
      url: args.flags.url,
      suite: args.flags.suite,
      components: (args.flags.components ?? "main").split(/[,\s]+/).filter(Boolean),
      signingKey,
      reason: args.flags.reason,
    }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.fingerprint) console.log(`Signing key fingerprint: ${res.fingerprint}`);
  console.log(describeRepoChange(res));
}

export async function runOrgReposRemoveCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("org repos remove <name|id> --reason <text>");
  const args = parseArgs(argv, readSpec({ values: ["reason"] }));
  const target = args.positionals[0];
  if (!target) throw new UsageError(`a repository is required\n\n${usage}`);
  if (!args.flags.reason) throw new UsageError(`--reason is required\n\n${usage}`);
  const list = await authenticatedApiRequest<{ items: AptRepositoryWire[] }>(
    "/api/v1/organisation/apt-repositories",
  );
  const repo = list.items.find(
    (r) => r.removedAt === null && (r.id === target || r.name === target),
  );
  if (!repo) throw new UsageError(`no active repository named or with id '${target}'`);
  const res = await authenticatedApiRequest<AptRepositoryChangeWire>(
    `/api/v1/organisation/apt-repositories/${repo.id}/remove`,
    postJson({ reason: args.flags.reason }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  console.log(describeRepoChange(res));
}
