import { useState } from "react";

import {
  ACTION_TYPE_LABELS,
  type Approval,
  useDecidedApprovalsQuery,
  usePendingApprovalsCount,
  usePendingApprovalsQuery,
} from "@/api/approvals";
import { Freshness } from "@/components/freshness";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { ApprovalDecisionDialog } from "./decision-dialog";

type View = "pending" | "decided";

const MODE_LABELS: Record<Approval["mode"], string> = {
  none: "None",
  single: "Single",
  dual: "Dual",
};

const STATUS_VARIANT: Record<Approval["status"], BadgeProps["variant"]> = {
  pending: "secondary",
  approved: "ok",
  rejected: "drift",
  expired: "stale",
};

function formatExpiry(expiresAt: string): { label: string; urgent: boolean } {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return { label: "—", urgent: false };
  if (diffMs <= 0) return { label: "expired", urgent: true };

  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) {
    // Sub-minute remaining still rounds to 0m, which reads as "already gone"
    // even though the row is still actionable — show seconds instead.
    const seconds = Math.max(1, Math.round(diffMs / 1000));
    return { label: `in ${seconds}s`, urgent: true };
  }
  if (minutes < 60) return { label: `in ${minutes}m`, urgent: minutes < 30 };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { label: `in ${hours}h`, urgent: hours < 2 };
  const days = Math.round(hours / 24);
  return { label: `in ${days}d`, urgent: false };
}

const VIEW_TABS: Array<{ key: View; label: string }> = [
  { key: "pending", label: "Pending queue" },
  { key: "decided", label: "Decided" },
];

function decisionSummary(approval: Approval): string {
  if (approval.mode === "none") return "—";
  return `${approval.approvedCount} / ${approval.requiredApprovals}`;
}

export function ApprovalsPage() {
  const [view, setView] = useState<View>("pending");
  const pendingCount = usePendingApprovalsCount();
  const pendingQuery = usePendingApprovalsQuery();
  const decidedQuery = useDecidedApprovalsQuery(view === "decided");

  const query = view === "pending" ? pendingQuery : decidedQuery;
  const rows = query.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <Badge
          variant={pendingCount ? "drift" : "secondary"}
          title="Pending approvals awaiting a decision"
        >
          {pendingCount ?? "…"} pending
        </Badge>
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        Sensitive actions — snapshot restore, break-glass, admin access to an unowned machine,
        offboarding — gated by org policy per action type: none, single, or dual approval. Every
        decision writes an event; denials require a reason and are evidence.
      </p>

      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Approval views">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={view === tab.key}
            onClick={() => setView(tab.key)}
            className={`px-3 py-2 text-sm font-medium ${
              view === tab.key
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && <p className="text-sm text-destructive">Failed to load approvals.</p>}

      {!query.isLoading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {view === "pending" ? "No approvals waiting on a decision." : "No decided approvals yet."}
        </p>
      )}

      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Requester</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Decisions</TableHead>
              {view === "pending" ? (
                <TableHead>Expires</TableHead>
              ) : (
                <>
                  <TableHead>Status</TableHead>
                  <TableHead>Decided</TableHead>
                </>
              )}
              {view === "pending" && <TableHead>Decide</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((approval) => {
              const expiry = formatExpiry(approval.expiresAt);
              return (
                <TableRow key={approval.id}>
                  <TableCell>{approval.requestedByName}</TableCell>
                  <TableCell>{ACTION_TYPE_LABELS[approval.actionType]}</TableCell>
                  <TableCell className="font-mono text-xs">{approval.targetLabel}</TableCell>
                  <TableCell className="max-w-xs truncate" title={approval.reason}>
                    {approval.reason}
                  </TableCell>
                  <TableCell>{MODE_LABELS[approval.mode]}</TableCell>
                  <TableCell>{decisionSummary(approval)}</TableCell>
                  {view === "pending" ? (
                    <TableCell className={expiry.urgent ? "text-drift" : "text-muted-foreground"}>
                      {expiry.label}
                    </TableCell>
                  ) : (
                    <>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[approval.status]}>{approval.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {approval.decidedAt ? (
                          <Freshness
                            occurredAt={approval.decidedAt}
                            recordedAt={approval.decidedAt}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </>
                  )}
                  {view === "pending" && (
                    <TableCell>
                      <div className="flex gap-2">
                        <ApprovalDecisionDialog approval={approval} decision="approved" />
                        <ApprovalDecisionDialog approval={approval} decision="rejected" />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
