// ---------------------------------------------------------------------------
// `cloudable snapshots *` — the archive side of the lifecycle.
//
// A snapshot is what an archived machine leaves behind. Restoring one is an
// approval-gated action, so `restore` may come back pending: `restore-sync`
// resumes it once the approval is decided (`docs/lifecycle.md`). Legal hold
// stops the retention clock from expiring the data.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, positiveInt, readSpec, required, requiredFlag } from "./args";
import { authenticatedApiRequest, postJson, query } from "./http-client";
import { dash, printEmpty, printFields, printJson, printTable, shortTime } from "./output";
import { usageFor } from "./program";
import { machineId } from "./resolve";

interface SnapshotView {
  id: string;
  orgId: string;
  machineId: string;
  trigger: "archive" | "upgrade" | "manual";
  region: string | null;
  sizeBytes: number | null;
  containsData: boolean;
  containsConfig: boolean;
  legalHold: boolean;
  legalHoldReason: string | null;
  retentionDays: number;
  createdAt: string;
  expiresAt: string;
  expiredAt: string | null;
  subState: "restorable" | "expired";
  restoreUnavailableReason: string | null;
}

interface RestoreResult {
  snapshotId: string;
  targetMachineId: string;
  mode: "data" | "config" | "full";
  approvalId: string;
  approvalStatus: "pending" | "approved" | "rejected" | "expired";
  restored: boolean;
}

function gib(bytes: number | null): string {
  if (bytes === null) return dash(null);
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function contents(snapshot: SnapshotView): string {
  const parts = [
    snapshot.containsData ? "data" : undefined,
    snapshot.containsConfig ? "config" : undefined,
  ].filter(Boolean);
  return parts.length === 0 ? dash(null) : parts.join("+");
}

export async function runSnapshotsListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ values: ["limit", "cursor"] }));
  const limit = args.flags.limit ? positiveInt(args.flags.limit, "limit") : undefined;
  const page = await authenticatedApiRequest<{
    items: SnapshotView[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }>(`/api/v1/archive/snapshots${query({ limit, cursor: args.flags.cursor })}`);

  if (args.booleans.has("json")) {
    printJson(page);
    return;
  }
  if (page.items.length === 0) {
    printEmpty("snapshots");
    return;
  }
  printTable(
    ["id", "machine", "trigger", "holds", "size", "state", "expires"],
    page.items.map((s) => [
      s.id,
      s.machineId,
      s.trigger,
      contents(s),
      gib(s.sizeBytes),
      s.legalHold ? `${s.subState} (legal hold)` : s.subState,
      shortTime(s.expiresAt),
    ]),
  );
  if (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
    console.log(`\nMore. Continue with --cursor ${page.pageInfo.nextCursor}`);
  }
}

export async function runSnapshotsGetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = required(args, 0, "a snapshot id", usageFor("snapshots get <snapshotId>"));
  const snapshot = await authenticatedApiRequest<SnapshotView>(`/api/v1/archive/snapshots/${id}`);
  if (args.booleans.has("json")) {
    printJson(snapshot);
    return;
  }
  printFields([
    ["id", snapshot.id],
    ["machine", snapshot.machineId],
    ["trigger", snapshot.trigger],
    ["contains", contents(snapshot)],
    ["size", gib(snapshot.sizeBytes)],
    ["region", dash(snapshot.region)],
    ["state", snapshot.subState],
    ["legal hold", snapshot.legalHold ? `yes (${dash(snapshot.legalHoldReason)})` : "no"],
    ["retention", `${snapshot.retentionDays} days`],
    ["created", shortTime(snapshot.createdAt)],
    ["expires", shortTime(snapshot.expiresAt)],
    ["expired", shortTime(snapshot.expiredAt)],
    ["restore blocked by", dash(snapshot.restoreUnavailableReason)],
  ]);
}

export async function runSnapshotsCostCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = required(args, 0, "a snapshot id", usageFor("snapshots cost <snapshotId>"));
  const estimate = await authenticatedApiRequest<{
    snapshotId: string;
    estimatedCostUsd: number;
    currency: "USD";
    disclaimer: string;
  }>(`/api/v1/archive/snapshots/${id}/cost-estimate`);
  if (args.booleans.has("json")) {
    printJson(estimate);
    return;
  }
  printFields([
    ["snapshot", estimate.snapshotId],
    ["estimate", `${estimate.estimatedCostUsd.toFixed(2)} ${estimate.currency}`],
  ]);
  console.log(`\n${estimate.disclaimer}`);
}

export async function runSnapshotsRestoreCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "snapshots restore <snapshotId> --mode data|config|full --target <machine> --reason <reason> [--confirm-secret-bindings]",
  );
  const args = parseArgs(
    argv,
    readSpec({
      values: ["mode", "target", "reason"],
      booleans: ["confirm-secret-bindings"],
    }),
  );
  const snapshotId = required(args, 0, "a snapshot id", usage);
  const mode = oneOf(
    requiredFlag(args, "mode", usage),
    ["data", "config", "full"] as const,
    "mode",
  );
  const targetMachineId = await machineId(requiredFlag(args, "target", usage));

  const result = await authenticatedApiRequest<RestoreResult>(
    `/api/v1/archive/snapshots/${snapshotId}/restore`,
    postJson({
      mode,
      targetMachineId,
      reason: requiredFlag(args, "reason", usage),
      ...(args.booleans.has("confirm-secret-bindings") ? { confirmSecretBindings: true } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  printFields([
    ["snapshot", result.snapshotId],
    ["target", result.targetMachineId],
    ["mode", result.mode],
    ["approval", result.approvalId],
    ["approval status", result.approvalStatus],
    ["restored", result.restored ? "yes" : "no"],
  ]);
  if (!result.restored) {
    console.log(
      `\nNot restored yet. Once the approval is decided, run \`cloudable snapshots restore-sync ${result.approvalId}\`.`,
    );
  }
}

export async function runSnapshotsRestoreSyncCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const approvalId = required(
    args,
    0,
    "an approval id",
    usageFor("snapshots restore-sync <approvalId>"),
  );
  const result = await authenticatedApiRequest<RestoreResult>(
    `/api/v1/archive/restores/${approvalId}/sync`,
    postJson({}),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  console.log(
    result.restored
      ? `Restored ${result.snapshotId} onto ${result.targetMachineId} (${result.mode}).`
      : `Still ${result.approvalStatus}. Nothing was restored.`,
  );
}

async function legalHold(argv: ReadonlyArray<string>, on: boolean): Promise<void> {
  const usage = on
    ? usageFor("snapshots legal-hold set <snapshotId> --reason <reason>")
    : usageFor("snapshots legal-hold clear <snapshotId>");
  const args = parseArgs(argv, readSpec({ values: on ? ["reason"] : [] }));
  const id = required(args, 0, "a snapshot id", usage);

  const result = await authenticatedApiRequest<{
    snapshotId: string;
    legalHold: boolean;
    legalHoldReason: string | null;
  }>(
    on
      ? `/api/v1/archive/snapshots/${id}/legal-hold`
      : `/api/v1/archive/snapshots/${id}/legal-hold/clear`,
    postJson(on ? { reason: requiredFlag(args, "reason", usage) } : {}),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  console.log(
    result.legalHold
      ? `Legal hold on ${result.snapshotId}: ${dash(result.legalHoldReason)}. Retention cannot expire it.`
      : `Legal hold cleared on ${result.snapshotId}. Retention applies again.`,
  );
}

export const runSnapshotsLegalHoldSetCommand = (argv: ReadonlyArray<string>) =>
  legalHold(argv, true);
export const runSnapshotsLegalHoldClearCommand = (argv: ReadonlyArray<string>) =>
  legalHold(argv, false);
