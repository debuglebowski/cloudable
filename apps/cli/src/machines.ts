// ---------------------------------------------------------------------------
// `cloudable machines *` — the desired-state surface. Everything here edits
// desired state or asks the agent to apply it; nothing reaches into a live
// machine (invariant 10).
//
// Every command takes a machine name or a machine id, resolved by `resolve.ts`
// so the ids printed by `machines list` are never the only way in.
// ---------------------------------------------------------------------------
import type {
  MachineCompute,
  MachineDetail,
  MachineSummary,
  PackageEnsureApprovalView,
  PackageManifestEdit,
  PackageSetting,
  ResizeMachineResponse,
  ResolvedPackageManifestEntry,
  UpdateMachinePackagesResponse,
} from "@cloudable/contracts";
import { type Args, oneOf, parseArgs, positiveInt, readSpec, required, requiredFlag } from "./args";
import { UsageError } from "./errors";
import { authenticatedApiRequest, patchJson, postJson } from "./http-client";
import { dash, printEmpty, printFields, printJson, printTable, shortTime } from "./output";
import { usageFor } from "./program";
import { listMachines, machineId, personId } from "./resolve";

/** The runtime response carries two fields the contracts copy has not caught up with. */
type MachineSummaryWire = MachineSummary & { lastError: string | null };
type MachineDetailWire = MachineDetail &
  MachineSummaryWire & { loggingTier?: { tier: 1 | 2; source: string } };

interface RestartResponse {
  machineId: string;
  state: "running";
  restartedAt: string;
}

interface UpgradeResponse {
  outcome: "success" | "rolled_back" | "aborted" | "rollback_failed";
  machineId: string;
  previousImage: string;
  currentImage: string;
  targetImage: string;
  snapshotId: string | null;
  nextEligibleAt: string;
  driftUrl?: string;
  failureReason?: string;
}

interface ArchiveResponse {
  machineId: string;
  state: "archived_restorable";
  snapshotId: string;
  retentionExpiresAt: string;
}

const STATE_LABEL: Record<MachineSummary["state"], string> = {
  provisioning: "provisioning",
  running: "running",
  stopped: "stopped",
  archived_restorable: "archived (restorable)",
  archived_expired: "archived (expired)",
  error: "error",
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function runMachinesListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ values: ["limit", "cursor"] }));
  const limit = args.flags.limit ? positiveInt(args.flags.limit, "limit") : undefined;
  const page = await listMachines(limit, args.flags.cursor);

  if (args.booleans.has("json")) {
    printJson(page);
    return;
  }
  if (page.items.length === 0) {
    printEmpty("machines");
    return;
  }
  printTable(
    ["id", "name", "state", "region", "size", "image"],
    page.items.map((m) => [m.id, m.name, STATE_LABEL[m.state], dash(m.region), m.sizeSku, m.image]),
  );
  if (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
    console.log(`\nMore. Continue with --cursor ${page.pageInfo.nextCursor}`);
  }
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

/** The labels people see for a package's setting, here and in the console. */
export const SETTING_LABELS: Record<PackageSetting, string> = {
  allowed: "Allowed",
  ensure_installed: "Ensure installed",
  ensure_latest: "Ensure latest version",
};

/** Absent reads as `allowed`, as it does on the wire. */
export const settingLabel = (setting: PackageSetting | undefined): string =>
  SETTING_LABELS[setting ?? "allowed"];

function printManifestTable(manifest: ReadonlyArray<ResolvedPackageManifestEntry>): void {
  printTable(
    ["package", "version", "locked", "excluded", "setting", "part of", "from", "description"],
    manifest.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.locked ? "yes" : "no",
      entry.excluded ? "yes" : "no",
      settingLabel(entry.setting),
      dash(entry.partOf ?? null),
      entry.source,
      dash(entry.description ?? null),
    ]),
  );
}

function printManifest(manifest: ReadonlyArray<ResolvedPackageManifestEntry>): void {
  if (manifest.length === 0) {
    console.log("\nNo declared packages.");
    return;
  }
  console.log("\npackages:");
  printManifestTable(manifest);
}

/**
 * One line per edit that set an Ensure setting. Each waits for its approval,
 * unless the org's `package_ensure` mode is `none` and it already applied.
 */
export function describeEnsureApprovals(
  approvals: ReadonlyArray<PackageEnsureApprovalView>,
  upserts: ReadonlyArray<PackageManifestEdit>,
): string[] {
  return approvals.map((approval) => {
    switch (approval.status) {
      case "pending":
        return `${approval.packageName}: waiting for approval ${approval.approvalId}`;
      case "approved": {
        const edit = upserts.find((u) => u.packageName === approval.packageName && u.setting);
        return edit
          ? `${approval.packageName}: set to ${settingLabel(edit.setting)}`
          : `${approval.packageName}: setting changed`;
      }
      case "rejected":
        return `${approval.packageName}: not changed, approval ${approval.approvalId} was rejected`;
      case "expired":
        return `${approval.packageName}: not changed, approval ${approval.approvalId} expired`;
    }
  });
}

export async function runMachinesGetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = await machineId(required(args, 0, "a machine", usageFor("machines get <machine>")));
  const machine = await authenticatedApiRequest<MachineDetailWire>(`/api/v1/machines/${id}`);

  if (args.booleans.has("json")) {
    printJson(machine);
    return;
  }
  printFields([
    ["name", machine.name],
    ["id", machine.id],
    ["state", STATE_LABEL[machine.state]],
    ["provider", machine.provider],
    ["region", dash(machine.region)],
    ["size", machine.sizeSku],
    ["image", machine.image],
    ["owner", dash(machine.ownerPersonId)],
    [
      "logging tier",
      machine.loggingTier
        ? `${machine.loggingTier.tier} (from ${machine.loggingTier.source})`
        : dash(null),
    ],
    [
      "persistent paths",
      machine.persistentPaths.value.length === 0
        ? dash(null)
        : machine.persistentPaths.value.join(", "),
    ],
    [
      "access",
      [
        machine.accessMethodsEnabled.value.webTerminal ? "web terminal" : undefined,
        machine.accessMethodsEnabled.value.ssh ? "ssh" : undefined,
        machine.accessMethodsEnabled.value.files ? "files" : undefined,
      ]
        .filter(Boolean)
        .join(", ") || "none",
    ],
    ["created", shortTime(machine.createdAt)],
    ["last verified", shortTime(machine.lastVerifiedAt)],
    ["last error", dash(machine.lastError)],
  ]);
  printManifest(machine.manifest);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const CREATE_USAGE = usageFor(
  "machines create --owner <email|id> [--profile <profile>] [--provider azure|docker|fake] [--size <sku>] [--image <image>] [--region <region>] [--name <name>]\n\n--provider, --size and --image are required unless the profile sets them.",
);

export async function runMachinesCreateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(
    argv,
    readSpec({ values: ["owner", "provider", "size", "image", "region", "name", "profile"] }),
  );
  const provider = args.flags.provider
    ? oneOf(args.flags.provider, ["azure", "docker", "fake"] as const, "provider")
    : undefined;
  // Without a profile, nothing else can fill these in.
  if (!args.flags.profile) {
    requiredFlag(args, "provider", CREATE_USAGE);
    requiredFlag(args, "size", CREATE_USAGE);
    requiredFlag(args, "image", CREATE_USAGE);
  }
  const owner = await personId(requiredFlag(args, "owner", CREATE_USAGE));
  const { profileId } = await import("./profiles");
  const profile = args.flags.profile ? await profileId(args.flags.profile) : undefined;
  const machine = await authenticatedApiRequest<MachineSummaryWire>(
    "/api/v1/machines",
    postJson({
      ownerPersonId: owner,
      ...(provider ? { provider } : {}),
      ...(args.flags.size ? { sizeSku: args.flags.size } : {}),
      ...(args.flags.image ? { image: args.flags.image } : {}),
      ...(args.flags.region ? { region: args.flags.region } : {}),
      ...(args.flags.name ? { name: args.flags.name } : {}),
      ...(profile ? { profileId: profile } : {}),
    }),
  );

  if (args.booleans.has("json")) {
    printJson(machine);
    return;
  }
  console.log(`Creating ${machine.name} (${machine.id}).`);
  console.log("Provisioning runs in the background. Watch it with `cloudable machines get`.");
}

export async function runMachinesSetProfileCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("machines set-profile <machine> <profile|none>");
  const args = parseArgs(argv, readSpec());
  const id = await machineId(required(args, 0, "a machine", usage));
  const target = required(args, 1, "a profile, or none", usage);
  const { profileId } = await import("./profiles");
  const profile = target === "none" ? null : await profileId(target);
  const machine = await authenticatedApiRequest<MachineSummaryWire>(
    `/api/v1/machines/${id}/profile`,
    { method: "PUT", body: JSON.stringify({ profileId: profile }) },
  );
  if (args.booleans.has("json")) {
    printJson(machine);
    return;
  }
  console.log(
    profile === null
      ? `${machine.name} is on no profile now. Its settings come from the org and itself.`
      : `${machine.name} is on profile ${target} now. Its settings resolve through it.`,
  );
}

// ---------------------------------------------------------------------------
// restart, upgrade, reconcile, archive
// ---------------------------------------------------------------------------

export async function runMachinesRestartCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = await machineId(
    required(args, 0, "a machine", usageFor("machines restart <machine>")),
  );
  const result = await authenticatedApiRequest<RestartResponse>(
    `/api/v1/machines/${id}/restart`,
    postJson({}),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  console.log(`Restarted ${result.machineId} at ${shortTime(result.restartedAt)}.`);
}

export async function runMachinesUpgradeCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("machines upgrade <machine> --image <image> [--snapshot <scope>]");
  const args = parseArgs(argv, readSpec({ values: ["image", "snapshot"] }));
  const id = await machineId(required(args, 0, "a machine", usage));
  const targetImage = requiredFlag(args, "image", usage);
  // Defaults to "full" server-side. Sent only when asked for, so the default lives in
  // one place rather than being restated by every client.
  const snapshotScope = args.flags.snapshot
    ? oneOf(args.flags.snapshot, ["full", "shallow"] as const, "snapshot")
    : undefined;

  const result = await authenticatedApiRequest<UpgradeResponse>(
    `/api/v1/machines/${id}/upgrade`,
    postJson(snapshotScope ? { targetImage, snapshotScope } : { targetImage }),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }

  const outcome: Record<UpgradeResponse["outcome"], string> = {
    success: `Upgraded to ${result.currentImage}.`,
    rolled_back: `Upgrade failed and was rolled back to ${result.currentImage}.`,
    aborted: "Upgrade never started.",
    // Deliberately does NOT name an image. `currentImage` is set to the PREVIOUS image
    // on every non-success outcome, which is a true statement for "aborted" and would
    // be one after a real rollback — but here the reimage already happened and the old
    // OS disk is gone, so the machine is not on that image and claiming otherwise sends
    // someone looking in the wrong place.
    rollback_failed: "Upgrade failed and was NOT rolled back. The machine needs manual attention.",
  };
  console.log(outcome[result.outcome]);
  if (result.failureReason) console.log(`Reason: ${result.failureReason}`);
  if (result.snapshotId) console.log(`Snapshot taken first: ${result.snapshotId}`);
  if (result.driftUrl) console.log(`Drift: ${result.driftUrl}`);
  if (result.outcome !== "success") process.exitCode = 1;
}

export async function runMachinesArchiveCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ values: ["approval"] }));
  const id = await machineId(
    required(args, 0, "a machine", usageFor("machines archive <machine> [--approval <id>]")),
  );
  const result = await authenticatedApiRequest<ArchiveResponse>(
    `/api/v1/archive/machines/${id}/archive`,
    postJson(args.flags.approval ? { approvalId: args.flags.approval } : {}),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  printFields([
    ["machine", result.machineId],
    ["state", STATE_LABEL[result.state]],
    ["snapshot", result.snapshotId],
    ["retention expires", shortTime(result.retentionExpiresAt)],
  ]);
  console.log("\nArchived, never deleted. The record stays; the data expires.");
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

/**
 * `curl` or `curl@8.5.0` — the pin travels with the name, as it does in the
 * manifest. Other package managers take a prefix: `npm:playwright`,
 * `npm:@openai/codex@0.5.0`, `pipx:black`, `cargo:ripgrep`, `home:<name>`. The
 * `@` that opens an npm scope is part of the name, not a pin.
 */
export function parsePackageArg(value: string, locked: boolean): PackageManifestEdit {
  const nameStart = value.indexOf(":") + 1;
  const at = value.lastIndexOf("@");
  const hasPin = at > nameStart;
  const packageName = hasPin ? value.slice(0, at) : value;
  const versionPin = hasPin ? value.slice(at + 1) : undefined;
  if (packageName === "") throw new UsageError(`'${value}' is not a package name`);
  // Both fields are always sent: the wire schema takes them as optional, but
  // the contracts type has them explicit, and "no pin" is a value, not a gap.
  return { packageName, versionPin: versionPin ?? null, locked };
}

/**
 * `--remove` and `--exclude` are different edits, not synonyms. `--remove`
 * deletes this machine's own row so the org's entry applies again;
 * `--exclude` writes a row saying the package must not be here at all, which
 * beats the org. `--include` undoes an exclusion without touching the pin or
 * version the row already carries.
 *
 * `--ensure <pkg>` sets a package to Ensure installed, `--ensure-latest <pkg>`
 * to Ensure latest version, and `--allow <pkg>` back to Allowed. Like
 * `--exclude`, they send only the setting, so the pin and the rest keep their
 * value. Moving to an Ensure setting waits for a `package_ensure` approval.
 *
 * `--part-of <parent>` makes every `--add`/`--lock` in the same command a part
 * of that declared parent: allowed only while the parent is. `--standalone
 * <pkg>` clears a package's parent. `--description <text>` records why every
 * `--add`/`--lock` in the command is allowed.
 */
/** The repeatable flags both `machines packages set` and `org packages set` take. */
export const PACKAGE_EDIT_FLAGS = [
  "add",
  "lock",
  "remove",
  "standalone",
  "ensure",
  "ensure-latest",
  "allow",
] as const;

export function packageEdits(args: Args): {
  upserts: PackageManifestEdit[];
  removals: string[];
} {
  const partOf = args.flags["part-of"];
  const description = args.flags.description;
  const withParent = (edit: PackageManifestEdit): PackageManifestEdit => ({
    ...edit,
    ...(partOf ? { partOf } : {}),
    ...(description ? { description } : {}),
  });
  const upserts = [
    ...(args.all.add ?? []).map((value) => withParent(parsePackageArg(value, false))),
    ...(args.all.lock ?? []).map((value) => withParent(parsePackageArg(value, true))),
    ...(args.all.exclude ?? []).map((packageName) => ({ packageName, excluded: true })),
    ...(args.all.include ?? []).map((packageName) => ({ packageName, excluded: false })),
    ...(args.all.standalone ?? []).map((packageName) => ({ packageName, partOf: null })),
    ...(args.all.ensure ?? []).map((packageName) => ({
      packageName,
      setting: "ensure_installed" as const,
    })),
    ...(args.all["ensure-latest"] ?? []).map((packageName) => ({
      packageName,
      setting: "ensure_latest" as const,
    })),
    ...(args.all.allow ?? []).map((packageName) => ({
      packageName,
      setting: "allowed" as const,
    })),
  ];
  return { upserts, removals: [...(args.all.remove ?? [])] };
}

export async function runMachinesPackagesListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = await machineId(
    required(args, 0, "a machine", usageFor("machines packages list <machine>")),
  );
  const machine = await authenticatedApiRequest<MachineDetailWire>(`/api/v1/machines/${id}`);
  if (args.booleans.has("json")) {
    printJson({ manifest: machine.manifest });
    return;
  }
  if (machine.manifest.length === 0) {
    printEmpty("declared packages");
    return;
  }
  printManifestTable(machine.manifest);
}

export async function runMachinesPackagesSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "machines packages set <machine> [--add <pkg>[@<version>]] [--lock <pkg>[@<version>]] [--remove <pkg>] [--exclude <pkg>] [--include <pkg>] [--part-of <parent>] [--description <text>] [--standalone <pkg>] [--ensure <pkg>] [--ensure-latest <pkg>] [--allow <pkg>]\n\n<pkg> is an apt name, or npm:<name>, pipx:<name>, cargo:<name>, home:<name>. Only apt packages can be ensured.",
  );
  const args = parseArgs(
    argv,
    readSpec({
      values: ["part-of", "description"],
      repeatable: [...PACKAGE_EDIT_FLAGS, "exclude", "include"],
    }),
  );
  const id = await machineId(required(args, 0, "a machine", usage));
  const { upserts, removals } = packageEdits(args);
  if (upserts.length === 0 && removals.length === 0) {
    throw new UsageError(`nothing to change\n\n${usage}`);
  }

  const result = await authenticatedApiRequest<UpdateMachinePackagesResponse>(
    `/api/v1/machines/${id}/packages`,
    patchJson({
      ...(upserts.length > 0 ? { upserts } : {}),
      ...(removals.length > 0 ? { removals } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  // Deliberately does not tell you to run `machines reconcile`: there is no
  // apply step. An Allowed package installs only when a person asks for it.
  // An Ensure package is queued by the control plane on the machine's next
  // report, once its setting is approved. Nothing reads the
  // `desiredStateVersion` that a reconcile trigger bumps.
  console.log("Desired state updated.");
  for (const line of describeEnsureApprovals(result.ensureApprovals ?? [], upserts))
    console.log(line);
  printManifest(result.manifest);
}

// ---------------------------------------------------------------------------
// compute, resize
// ---------------------------------------------------------------------------

export async function runMachinesComputeCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("machines compute <machine> [--hours <n>]");
  const args = parseArgs(argv, readSpec({ values: ["hours"] }));
  const id = await machineId(required(args, 0, "a machine", usage));
  const hours = args.flags.hours ? `?hours=${encodeURIComponent(args.flags.hours)}` : "";
  const res = await authenticatedApiRequest<MachineCompute>(
    `/api/v1/machines/${id}/compute${hours}`,
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (!res.available) {
    console.log(res.unavailableReason ?? "No measurements for this machine.");
    return;
  }
  const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v)}%`);
  printFields([
    ["size", res.sizeSku],
    ["window", `${res.hours} hours`],
    ["average CPU", pct(res.summary.cpuAverage)],
    ["busiest hour", pct(res.summary.cpuPeak)],
    ...(res.burstable
      ? ([
          ["CPU credits now", String(Math.round(res.summary.creditsNow ?? 0))],
          ["hours throttled", String(res.summary.hoursWithoutCredits ?? 0)],
        ] as const)
      : ([["CPU credits", "none: this size is never throttled"]] as const)),
  ]);
}

export async function runMachinesResizeCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("machines resize <machine> --size <sku> --reason <text>");
  const args = parseArgs(argv, readSpec({ values: ["size", "reason"] }));
  const id = await machineId(required(args, 0, "a machine", usage));
  const res = await authenticatedApiRequest<ResizeMachineResponse>(
    `/api/v1/machines/${id}/resize`,
    postJson({
      sizeSku: requiredFlag(args, "size", usage),
      reason: requiredFlag(args, "reason", usage),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  console.log(
    res.status === "approved"
      ? "Resizing. The machine stops for a few minutes and starts again on the new size."
      : `Approval requested (${res.approvalId}). Nothing changes until an approver signs it off.`,
  );
}
