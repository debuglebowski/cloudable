// ---------------------------------------------------------------------------
// `cloudable approvals *` — the gate in front of restores, offboarding,
// break-glass and admin access.
//
// Who requested it, who decided it, and when, is the evidence the check
// `approval_before_privileged_action` reads (docs/compliance.md), so a decision
// made here is as good as one made in the console: same endpoint, same events.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, positiveInt, readSpec, required, requiredFlag } from "./args";
import { UsageError } from "./errors";
import { authenticatedApiRequest, postJson, query } from "./http-client";
import { dash, printEmpty, printFields, printJson, printTable, shortTime } from "./output";
import { usageFor } from "./program";
import { machineId } from "./resolve";

const ACTION_TYPES = ["snapshot_restore", "break_glass", "admin_access", "offboarding"] as const;
const STATUSES = ["pending", "approved", "rejected", "expired"] as const;

interface Approval {
  id: string;
  orgId: string;
  actionType: (typeof ACTION_TYPES)[number];
  mode: "none" | "single" | "dual";
  status: (typeof STATUSES)[number];
  requestedByPersonId: string;
  targetMachineId: string | null;
  targetPersonId: string | null;
  reason: string;
  requiredApprovals: number;
  approvedCount: number;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

function printApproval(approval: Approval): void {
  printFields([
    ["id", approval.id],
    ["action", approval.actionType],
    ["status", approval.status],
    ["mode", approval.mode],
    ["approvals", `${approval.approvedCount} of ${approval.requiredApprovals}`],
    ["requested by", approval.requestedByPersonId],
    ["target machine", dash(approval.targetMachineId)],
    ["target person", dash(approval.targetPersonId)],
    ["reason", approval.reason],
    ["created", shortTime(approval.createdAt)],
    ["expires", shortTime(approval.expiresAt)],
    ["decided", shortTime(approval.decidedAt)],
  ]);
}

export async function runApprovalsListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ values: ["status", "limit", "cursor"] }));
  const status = args.flags.status ? oneOf(args.flags.status, STATUSES, "status") : undefined;
  const limit = args.flags.limit ? positiveInt(args.flags.limit, "limit") : undefined;

  const page = await authenticatedApiRequest<{
    items: Approval[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }>(`/api/v1/approvals${query({ status, limit, cursor: args.flags.cursor })}`);

  if (args.booleans.has("json")) {
    printJson(page);
    return;
  }
  if (page.items.length === 0) {
    printEmpty(status ? `${status} approvals` : "approvals");
    return;
  }
  printTable(
    ["id", "action", "status", "approvals", "expires", "reason"],
    page.items.map((a) => [
      a.id,
      a.actionType,
      a.status,
      `${a.approvedCount}/${a.requiredApprovals}`,
      shortTime(a.expiresAt),
      a.reason,
    ]),
  );
  if (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
    console.log(`\nMore. Continue with --cursor ${page.pageInfo.nextCursor}`);
  }
}

export async function runApprovalsGetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = required(args, 0, "an approval id", usageFor("approvals get <id>"));
  const approval = await authenticatedApiRequest<Approval>(`/api/v1/approvals/${id}`);
  if (args.booleans.has("json")) {
    printJson(approval);
    return;
  }
  printApproval(approval);
}

export async function runApprovalsDecideCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("approvals decide <id> --approve|--deny [--reason <reason>]");
  const args = parseArgs(argv, readSpec({ values: ["reason"], booleans: ["approve", "deny"] }));
  const id = required(args, 0, "an approval id", usage);

  const approve = args.booleans.has("approve");
  const deny = args.booleans.has("deny");
  if (approve === deny) throw new UsageError(`pass exactly one of --approve or --deny\n\n${usage}`);

  const approval = await authenticatedApiRequest<Approval>(
    `/api/v1/approvals/${id}/decide`,
    postJson({
      decision: approve ? "approved" : "rejected",
      ...(args.flags.reason ? { reason: args.flags.reason } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(approval);
    return;
  }
  console.log(
    approval.status === "pending"
      ? `Recorded. ${approval.approvedCount} of ${approval.requiredApprovals} approvals — still pending.`
      : `Approval ${approval.id} is ${approval.status}.`,
  );
}

export async function runApprovalsCreateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    `approvals create --action ${ACTION_TYPES.join("|")} --reason <reason> [--machine <machine>]`,
  );
  const args = parseArgs(argv, readSpec({ values: ["action", "reason", "machine"] }));
  const actionType = oneOf(requiredFlag(args, "action", usage), ACTION_TYPES, "action");
  const targetMachineId = args.flags.machine ? await machineId(args.flags.machine) : null;

  const approval = await authenticatedApiRequest<Approval>(
    "/api/v1/approvals",
    postJson({ actionType, targetMachineId, reason: requiredFlag(args, "reason", usage) }),
  );
  if (args.booleans.has("json")) {
    printJson(approval);
    return;
  }
  printApproval(approval);
}
