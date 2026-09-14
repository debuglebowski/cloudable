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
import { authenticatedApiRequest, patchJson } from "./http-client";
import { type OrgWire, fetchOrg } from "./identity";
import { packageEdits } from "./machines";
import { dash, printEmpty, printFields, printJson, printTable } from "./output";
import { usageFor } from "./program";

const APPROVAL_ACTIONS = [
  "snapshot_restore",
  "break_glass",
  "admin_access",
  "offboarding",
] as const;
const APPROVAL_MODES = ["none", "single", "dual"] as const;
const RETENTION_LOCATIONS = ["customer", "cloudable_sweden_central"] as const;

interface OrgPackageEntry {
  packageName: string;
  versionPin: string | null;
  pinned: boolean;
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
    ["retention", `${org.retentionDefaultDays} days`],
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
    "org update [--name <name>] [--logging-tier 1|2|3] [--retention-days <n>] [--retention-location customer|cloudable_sweden_central] [--approval-mode <action>=<mode>]",
  );
  const args = parseArgs(
    argv,
    readSpec({
      values: ["name", "logging-tier", "retention-days", "retention-location"],
      repeatable: ["approval-mode"],
    }),
  );

  const modes = approvalModes(args.all["approval-mode"] ?? []);
  const payload: Record<string, unknown> = {};
  if (args.flags.name) payload.name = args.flags.name;
  if (args.flags["logging-tier"]) {
    payload.loggingTier = Number(
      oneOf(args.flags["logging-tier"], ["1", "2", "3"], "logging-tier"),
    );
  }
  if (args.flags["retention-days"]) {
    payload.retentionDefaultDays = positiveInt(args.flags["retention-days"], "retention-days");
  }
  if (args.flags["retention-location"]) {
    payload.retentionLocation = oneOf(
      args.flags["retention-location"],
      RETENTION_LOCATIONS,
      "retention-location",
    );
  }
  if (Object.keys(modes).length > 0) payload.approvalModes = modes;

  if (Object.keys(payload).length === 2) throw new UsageError(`nothing to change\n\n${usage}`);

  const org = await authenticatedApiRequest<OrgWire>("/api/v1/organisation", patchJson(payload));
  if (args.booleans.has("json")) {
    printJson(org);
    return;
  }
  printOrg(org);
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
    ["package", "version", "pinned"],
    res.items.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.pinned ? "yes" : "no",
    ]),
  );
}

export async function runOrgPackagesSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "org packages set [--add <pkg>[@<version>]] [--pin <pkg>[@<version>]] [--remove <pkg>]",
  );
  const args = parseArgs(argv, readSpec({ repeatable: ["add", "pin", "remove"] }));
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
    ["package", "version", "pinned"],
    res.items.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.pinned ? "yes" : "no",
    ]),
  );
}
