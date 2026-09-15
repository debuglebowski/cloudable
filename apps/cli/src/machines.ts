// ---------------------------------------------------------------------------
// `cloudable machines *` — the desired-state surface. Everything here edits
// desired state or asks the agent to apply it; nothing reaches into a live
// machine (invariant 10).
//
// Every command takes a machine name or a machine id, resolved by `resolve.ts`
// so the ids printed by `machines list` are never the only way in.
// ---------------------------------------------------------------------------
import type {
  MachineDetail,
  MachineSummary,
  PackageManifestEdit,
  ReconcileTriggerResponse,
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
  MachineSummaryWire & { loggingTier?: { tier: 1 | 2 | 3; source: string } };

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

function printManifest(manifest: ReadonlyArray<ResolvedPackageManifestEntry>): void {
  if (manifest.length === 0) {
    console.log("\nNo declared packages.");
    return;
  }
  console.log("\npackages:");
  printTable(
    ["package", "version", "pinned", "excluded", "from"],
    manifest.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.pinned ? "yes" : "no",
      entry.excluded ? "yes" : "no",
      entry.source,
    ]),
  );
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
  "machines create --owner <email|id> --provider azure|docker|fake --size <sku> --image <image> [--region <region>] [--name <name>]",
);

export async function runMachinesCreateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(
    argv,
    readSpec({ values: ["owner", "provider", "size", "image", "region", "name"] }),
  );
  const provider = oneOf(
    requiredFlag(args, "provider", CREATE_USAGE),
    ["azure", "docker", "fake"] as const,
    "provider",
  );
  const owner = await personId(requiredFlag(args, "owner", CREATE_USAGE));
  const machine = await authenticatedApiRequest<MachineSummaryWire>(
    "/api/v1/machines",
    postJson({
      provider,
      ownerPersonId: owner,
      sizeSku: requiredFlag(args, "size", CREATE_USAGE),
      image: requiredFlag(args, "image", CREATE_USAGE),
      ...(args.flags.region ? { region: args.flags.region } : {}),
      ...(args.flags.name ? { name: args.flags.name } : {}),
    }),
  );

  if (args.booleans.has("json")) {
    printJson(machine);
    return;
  }
  console.log(`Creating ${machine.name} (${machine.id}).`);
  console.log("Provisioning runs in the background. Watch it with `cloudable machines get`.");
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
  const usage = usageFor("machines upgrade <machine> --image <image>");
  const args = parseArgs(argv, readSpec({ values: ["image"] }));
  const id = await machineId(required(args, 0, "a machine", usage));
  const targetImage = requiredFlag(args, "image", usage);

  const result = await authenticatedApiRequest<UpgradeResponse>(
    `/api/v1/machines/${id}/upgrade`,
    postJson({ targetImage }),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }

  const outcome: Record<UpgradeResponse["outcome"], string> = {
    success: `Upgraded to ${result.currentImage}.`,
    rolled_back: `Upgrade failed and was rolled back to ${result.currentImage}.`,
    aborted: "Upgrade never started.",
    rollback_failed: `Upgrade failed AND the rollback failed. The machine is on ${result.currentImage}.`,
  };
  console.log(outcome[result.outcome]);
  if (result.failureReason) console.log(`Reason: ${result.failureReason}`);
  if (result.snapshotId) console.log(`Snapshot taken first: ${result.snapshotId}`);
  if (result.driftUrl) console.log(`Drift: ${result.driftUrl}`);
  if (result.outcome !== "success") process.exitCode = 1;
}

export async function runMachinesReconcileCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = await machineId(
    required(args, 0, "a machine", usageFor("machines reconcile <machine>")),
  );
  const result = await authenticatedApiRequest<ReconcileTriggerResponse>(
    `/api/v1/config/machines/${id}/reconcile`,
    postJson({ confirm: true }),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  // Says what the call did, not what it hoped would follow. The version bump
  // is real; nothing reads it yet (the agent poll endpoint still serves a
  // constant ETag), so promising an apply on the next poll was not true.
  console.log(
    `Desired state for ${result.machineId} is now version ${result.desiredStateVersion}.`,
  );
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

/** `curl` or `curl@8.5.0` — the pin travels with the name, as it does in the manifest. */
export function parsePackageArg(value: string, pinned: boolean): PackageManifestEdit {
  const at = value.lastIndexOf("@");
  const packageName = at > 0 ? value.slice(0, at) : value;
  const versionPin = at > 0 ? value.slice(at + 1) : undefined;
  if (packageName === "") throw new UsageError(`'${value}' is not a package name`);
  // Both fields are always sent: the wire schema takes them as optional, but
  // the contracts type has them explicit, and "no pin" is a value, not a gap.
  return { packageName, versionPin: versionPin ?? null, pinned };
}

/**
 * `--remove` and `--exclude` are different edits, not synonyms. `--remove`
 * deletes this machine's own row so the org's entry applies again;
 * `--exclude` writes a row saying the package must not be here at all, which
 * beats the org. `--include` undoes an exclusion without touching the pin or
 * version the row already carries.
 */
export function packageEdits(args: Args): {
  upserts: PackageManifestEdit[];
  removals: string[];
} {
  const upserts = [
    ...(args.all.add ?? []).map((value) => parsePackageArg(value, false)),
    ...(args.all.pin ?? []).map((value) => parsePackageArg(value, true)),
    ...(args.all.exclude ?? []).map((packageName) => ({ packageName, excluded: true })),
    ...(args.all.include ?? []).map((packageName) => ({ packageName, excluded: false })),
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
  printTable(
    ["package", "version", "pinned", "excluded", "from"],
    machine.manifest.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.pinned ? "yes" : "no",
      entry.excluded ? "yes" : "no",
      entry.source,
    ]),
  );
}

export async function runMachinesPackagesSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "machines packages set <machine> [--add <pkg>[@<version>]] [--pin <pkg>[@<version>]] [--remove <pkg>] [--exclude <pkg>] [--include <pkg>]",
  );
  const args = parseArgs(
    argv,
    readSpec({ repeatable: ["add", "pin", "remove", "exclude", "include"] }),
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
  // Deliberately does not tell you to run `machines reconcile`: reconcile only
  // ever removes undeclared software, it never installs, and nothing reads the
  // `desiredStateVersion` that a reconcile trigger bumps. Saying otherwise
  // promised an apply step that does not exist.
  console.log("Desired state updated.");
  printManifest(result.manifest);
}
