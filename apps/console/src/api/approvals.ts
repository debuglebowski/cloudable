import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api-client";
import { listMachines } from "./machines";
import { listPeople } from "./people-directory";

/**
 * Console-side data layer for the Approvals page (spec §13 "Approvals" / §20
 * "Approvals (badged queue)"), wired to the real `apps/control-plane/src/
 * http/routes/approvals.ts` (unit 5). One real gap versus the richer shape
 * this used to mock: the real `ApprovalResource` has no per-decision
 * history (who voted, when, with what reason) — only a running
 * `approvedCount`. Dual-mode approvals can no longer show "Priya approved,
 * waiting on one more"; they show "1 / 2" instead.
 *
 * "Who is deciding" is the signed-in session (`CurrentUserTag`, server-
 * side) — not a client-supplied id — see `decision-dialog.tsx`.
 */

export type ApprovalActionType =
  | "snapshot_restore"
  | "break_glass"
  | "admin_access"
  | "offboarding";

export type ApprovalMode = "none" | "single" | "dual";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type Decision = "approved" | "rejected";

export interface Approval {
  id: string;
  actionType: ApprovalActionType;
  mode: ApprovalMode;
  status: ApprovalStatus;
  requestedByName: string;
  reason: string;
  /** Human-readable target, e.g. "machine: db-prod-03". Falls back to the raw id
   * when the target machine can't be resolved (deleted, or missing from the
   * fetched machine list). */
  targetLabel: string;
  requiredApprovals: number;
  approvedCount: number;
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

interface ApprovalResourceWire {
  id: string;
  orgId: string;
  actionType: ApprovalActionType;
  mode: ApprovalMode;
  status: ApprovalStatus;
  requestedByPersonId: string;
  targetMachineId: string | null;
  /** Set only by person-targeted action types (today: `offboarding`). */
  targetPersonId: string | null;
  reason: string;
  requiredApprovals: number;
  approvedCount: number;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

async function toApproval(wire: ApprovalResourceWire): Promise<Approval> {
  const [people, machines] = await Promise.all([listPeople(), listMachines()]);
  const requester = people.find((p) => p.id === wire.requestedByPersonId);
  const machine = wire.targetMachineId
    ? machines.find((m) => m.id === wire.targetMachineId)
    : undefined;
  const targetPerson = wire.targetPersonId
    ? people.find((p) => p.id === wire.targetPersonId)
    : undefined;
  const targetLabel = wire.targetMachineId
    ? `machine: ${machine?.name ?? wire.targetMachineId}`
    : wire.targetPersonId
      ? `person: ${targetPerson?.email ?? wire.targetPersonId}`
      : "—";
  return {
    id: wire.id,
    actionType: wire.actionType,
    mode: wire.mode,
    status: wire.status,
    requestedByName: requester?.email ?? wire.requestedByPersonId,
    reason: wire.reason,
    targetLabel,
    requiredApprovals: wire.requiredApprovals,
    approvedCount: wire.approvedCount,
    createdAt: wire.createdAt,
    expiresAt: wire.expiresAt,
    decidedAt: wire.decidedAt,
  };
}

interface ApprovalListPage {
  items: ApprovalResourceWire[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

/**
 * Walks every page the real list endpoint has (`http/routes/approvals.ts` clamps
 * `limit` to 100 server-side, so a single `?limit=100` request silently dropped
 * every approval past the org's 100th — both queue tabs read off ONE unfiltered
 * fetch, so on a busy org this could even truncate `pending` while `decided` still
 * had room). Approvals are a governance queue, not high-volume telemetry, so
 * fetching every page up front (rather than real infinite-scroll/virtualization)
 * is the right tradeoff at this shape.
 */
async function fetchAllApprovals(): Promise<ApprovalResourceWire[]> {
  const items: ApprovalResourceWire[] = [];
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const page = await apiGet<ApprovalListPage>(`/api/v1/approvals?${params.toString()}`);
    items.push(...page.items);
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return items;
}

export async function fetchApprovals(view: "pending" | "decided"): Promise<Approval[]> {
  // The real list endpoint doesn't support "decided" (approved | rejected | expired)
  // as a single status filter — fetch every page unfiltered and split client-side.
  const all = await fetchAllApprovals();
  const filtered = all.filter((a) =>
    view === "pending" ? a.status === "pending" : a.status !== "pending",
  );
  return Promise.all(filtered.map(toApproval));
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: Decision;
  reason?: string;
}

export async function decideApproval(input: DecideApprovalInput): Promise<Approval> {
  const wire = await apiPost<ApprovalResourceWire>(`/api/v1/approvals/${input.approvalId}/decide`, {
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  return toApproval(wire);
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
    onSuccess: (_result, input) => {
      // Invalidates both lists — the nav badge updates too since it shares the
      // pending list's query key (see usePendingApprovalsCount above).
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
      toast.success(input.decision === "approved" ? "Approval granted" : "Approval denied");
    },
    // No onError toast here on purpose — decision-dialog.tsx already renders
    // `mutation.error` inline (the dialog stays open so the user can fix and
    // retry), and a toast on top of that would just say the same thing twice.
  });
}
