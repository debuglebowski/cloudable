import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Console-side data layer for the Approvals page (spec §13 "Approvals" / §20
 * "Approvals (badged queue)").
 *
 * BACKEND NOTE: `apps/control-plane/src/http/routes/approvals.ts` is being built by
 * feature unit 5 against `packages/schema/src/tables/approval.ts` and
 * `apps/control-plane/src/services/ApprovalService.ts` (currently a stub — every
 * method fails with "not_implemented"). That PR is open but not yet merged into the
 * bootstrap-only `main` this unit forked from, so there is no real endpoint to call.
 *
 * Everything below is a realistic in-memory mock with simulated network latency,
 * shaped to match the eventual real response (mirrors `approvals` /
 * `approval_decisions` columns and the `ApprovalRequest` / `ApprovalResult` /
 * `ApprovalDecision` shapes in `ApprovalService.ts`). Swapping `fetchApprovals` /
 * `decideApproval` for `apiGet`/`apiPost` calls against the real endpoint is the
 * only change needed once unit 5 lands — the query keys, hooks, and `Approval`
 * shape consumed by the page can stay as-is.
 *
 * The mock also encodes the two invariants a real backend must enforce
 * independently of the client: a decision is rejected once `expiresAt` has
 * passed (checked at decide-time, not just displayed as a countdown), and the
 * same identity cannot cast two decisions on one approval — which is what
 * actually makes dual mode "two distinct approvers" rather than "two clicks."
 * Both live in `decideApproval` below; mirror them when unit 5 replaces this.
 */

export type ApprovalActionType =
  | "snapshot_restore"
  | "break_glass"
  | "admin_access"
  | "offboarding";

export type ApprovalMode = "none" | "single" | "dual";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type Decision = "approved" | "rejected";

export interface ApprovalDecisionRecord {
  id: string;
  personName: string;
  decision: Decision;
  reason: string | null;
  decidedAt: string;
}

export interface Approval {
  id: string;
  actionType: ApprovalActionType;
  mode: ApprovalMode;
  status: ApprovalStatus;
  requestedByName: string;
  reason: string;
  /** Human-readable target, e.g. "machine: db-prod-03" or "person: Sam Okafor". */
  targetLabel: string;
  requiredApprovals: number;
  decisions: ApprovalDecisionRecord[];
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export const ACTION_TYPE_LABELS: Record<ApprovalActionType, string> = {
  snapshot_restore: "Snapshot restore",
  break_glass: "Break-glass",
  admin_access: "Admin access",
  offboarding: "Offboarding",
};

/** Domain-first query key tuples for the approvals feature. */
export const approvalKeys = {
  all: ["approvals"] as const,
  lists: () => [...approvalKeys.all, "list"] as const,
  list: (view: "pending" | "decided") => [...approvalKeys.lists(), view] as const,
};

const NETWORK_DELAY_MS = 200;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), NETWORK_DELAY_MS));
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * A `pending` approval whose `expiresAt` has passed is effectively expired even
 * before anything writes that back to `status` — derived at read time (and
 * re-checked independently in `decideApproval`) rather than requiring a
 * background sweep to flip the stored value.
 */
function effectiveStatus(approval: Approval): ApprovalStatus {
  if (approval.status === "pending" && new Date(approval.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return approval.status;
}

let nextDecisionId = 1;

/** In-memory mock store standing in for the `approvals` + `approval_decisions` tables. */
const store: Approval[] = [
  {
    id: "appr-1",
    actionType: "break_glass",
    mode: "dual",
    status: "pending",
    requestedByName: "Priya Natarajan",
    reason: "Customer P1 — production database locked, need shell to unblock a stuck migration.",
    targetLabel: "machine: db-prod-03",
    requiredApprovals: 2,
    decisions: [],
    createdAt: hoursAgo(0.5),
    expiresAt: hoursFromNow(1.5),
    decidedAt: null,
  },
  {
    id: "appr-2",
    actionType: "snapshot_restore",
    mode: "single",
    status: "pending",
    requestedByName: "Marcus Webb",
    reason: "Restore last night's snapshot after a bad config push wiped local state.",
    targetLabel: "machine: build-runner-11",
    requiredApprovals: 1,
    decisions: [],
    createdAt: hoursAgo(2),
    expiresAt: hoursFromNow(22),
    decidedAt: null,
  },
  {
    id: "appr-3",
    actionType: "admin_access",
    mode: "single",
    status: "pending",
    requestedByName: "Elena Ruiz",
    reason: "Owner is on leave; need to pull a log file for the SOC2 auditor's sample request.",
    targetLabel: "machine: analytics-02",
    requiredApprovals: 1,
    decisions: [],
    createdAt: hoursAgo(5),
    expiresAt: hoursFromNow(0.25),
    decidedAt: null,
  },
  {
    id: "appr-4",
    actionType: "offboarding",
    mode: "single",
    status: "approved",
    requestedByName: "People sync (SCIM)",
    reason: "Person deactivated in IdP — revoke access and archive their machine.",
    targetLabel: "person: Sam Okafor",
    requiredApprovals: 1,
    decisions: [
      {
        id: "dec-seed-4",
        personName: "Priya Natarajan",
        decision: "approved",
        reason: null,
        decidedAt: hoursAgo(20),
      },
    ],
    createdAt: hoursAgo(21),
    expiresAt: hoursAgo(20),
    decidedAt: hoursAgo(20),
  },
  {
    id: "appr-5",
    actionType: "snapshot_restore",
    mode: "single",
    status: "rejected",
    requestedByName: "Jordan Blake",
    reason: "Restore full config and secret bindings to a two-week-old snapshot.",
    targetLabel: "machine: staging-07",
    requiredApprovals: 1,
    decisions: [
      {
        id: "dec-seed-5",
        personName: "Priya Natarajan",
        decision: "rejected",
        reason: "Secret bindings are stale — re-provision the machine instead of restoring them.",
        decidedAt: hoursAgo(30),
      },
    ],
    createdAt: hoursAgo(31),
    expiresAt: hoursAgo(7),
    decidedAt: hoursAgo(30),
  },
  {
    id: "appr-6",
    actionType: "break_glass",
    mode: "dual",
    status: "expired",
    requestedByName: "Marcus Webb",
    reason: "Investigate a suspected memory leak — needed shell access overnight.",
    targetLabel: "machine: worker-04",
    requiredApprovals: 2,
    decisions: [
      {
        id: "dec-seed-6",
        personName: "Elena Ruiz",
        decision: "approved",
        reason: null,
        decidedAt: hoursAgo(50),
      },
    ],
    createdAt: hoursAgo(52),
    expiresAt: hoursAgo(28),
    decidedAt: null,
  },
];

export async function fetchApprovals(view: "pending" | "decided"): Promise<Approval[]> {
  const rows = store
    .map((approval) => ({ ...approval, status: effectiveStatus(approval) }))
    .filter((approval) =>
      view === "pending" ? approval.status === "pending" : approval.status !== "pending",
    );
  return delay(rows.map((approval) => ({ ...approval, decisions: [...approval.decisions] })));
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: Decision;
  decidedByName: string;
  reason?: string;
}

export async function decideApproval(input: DecideApprovalInput): Promise<Approval> {
  const approval = store.find((candidate) => candidate.id === input.approvalId);
  if (!approval) {
    throw new Error(`Approval ${input.approvalId} not found`);
  }

  const currentStatus = effectiveStatus(approval);
  if (currentStatus !== "pending") {
    throw new Error(
      currentStatus === "expired"
        ? "This approval expired before a decision was recorded."
        : "This approval has already been decided.",
    );
  }
  if (input.decision === "rejected" && !input.reason?.trim()) {
    throw new Error("A reason is required to deny an approval.");
  }
  // Dual mode means two *distinct* approvers — without this, the same identity
  // could click Grant twice and satisfy requiredApprovals alone. Mock identity is
  // just a name (see CURRENT_APPROVER_NAME in decision-dialog.tsx); a real backend
  // keys this on the authenticated person's id instead.
  if (approval.decisions.some((decision) => decision.personName === input.decidedByName)) {
    throw new Error(`This approval already has a decision recorded from ${input.decidedByName}.`);
  }

  const decisionRecord: ApprovalDecisionRecord = {
    id: `dec-${nextDecisionId++}`,
    personName: input.decidedByName,
    decision: input.decision,
    reason: input.reason?.trim() || null,
    decidedAt: new Date().toISOString(),
  };
  approval.decisions.push(decisionRecord);

  if (input.decision === "rejected") {
    // Every decision writes an event, granted or denied — denials are evidence, and a
    // single denial resolves the request rather than waiting out the other approver.
    approval.status = "rejected";
    approval.decidedAt = decisionRecord.decidedAt;
  } else {
    const approvedCount = approval.decisions.filter((d) => d.decision === "approved").length;
    if (approvedCount >= approval.requiredApprovals) {
      approval.status = "approved";
      approval.decidedAt = decisionRecord.decidedAt;
    }
    // else: dual mode with one approval in — stays pending for the second approver.
  }

  return delay({ ...approval, decisions: [...approval.decisions] });
}

export function usePendingApprovalsQuery() {
  return useQuery({
    queryKey: approvalKeys.list("pending"),
    queryFn: () => fetchApprovals("pending"),
    refetchInterval: 15_000,
  });
}

/** `enabled` lets the page skip fetching the tab that isn't currently shown. */
export function useDecidedApprovalsQuery(enabled = true) {
  return useQuery({
    queryKey: approvalKeys.list("decided"),
    queryFn: () => fetchApprovals("decided"),
    enabled,
  });
}

/**
 * Backs the nav item's live badge (registered in `src/nav-config.ts`). Deliberately
 * shares `usePendingApprovalsQuery`'s query key rather than hitting a separate
 * lightweight count endpoint: a distinct query with its own 15s timer would drift
 * out of phase with the page's list query and refetch the same rows a second time
 * whenever both are mounted together. Sharing the key means one poll, one fetch,
 * and the badge and the rendered row count can never disagree.
 */
export function usePendingApprovalsCount(): number | undefined {
  const { data } = usePendingApprovalsQuery();
  return data?.length;
}

export function useDecideApprovalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: decideApproval,
    onSuccess: () => {
      // Invalidates both lists — the nav badge updates too since it shares the
      // pending list's query key (see usePendingApprovalsCount above).
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}
