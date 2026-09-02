import {
  CheckSquare,
  Clock,
  Gauge,
  type LucideIcon,
  MessageSquare,
  Tag,
  Target as TargetGlyph,
  User,
  Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  ACTION_TYPE_LABELS,
  type Approval,
  useDecidedApprovalsQuery,
  usePendingApprovalsCount,
  usePendingApprovalsQuery,
} from "@/api/approvals";
import { Freshness } from "@/components/freshness";
import { PersonAvatar } from "@/components/person-avatar";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

/** `TableHead` + a small muted `TableHeaderIcon` naming the field's kind (see
 * that component's own comment) — same per-file wrapper as `access/page.tsx`'s
 * `Th`, not lifted into `TableHeaderIcon` itself since the icon-per-column
 * choice is specific to each table. */
function Th({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <TableHead>
      <span className="flex items-center gap-1.5">
        <TableHeaderIcon icon={icon} />
        {children}
      </span>
    </TableHead>
  );
}

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
    // h-full min-h-0 + flex-1 on the table wrapper below: fills whatever
    // height `main` actually has left instead of capping at a flat vh
    // fraction — see machines-page.tsx's identical comment.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-3">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <Badge
          variant={pendingCount ? "drift" : "secondary"}
          title="Pending approvals awaiting a decision"
        >
          {pendingCount ?? "…"} pending
        </Badge>
      </div>
      <p className="max-w-prose shrink-0 text-sm text-muted-foreground">
        Sensitive actions — snapshot restore, break-glass, admin access to an unowned machine,
        offboarding — gated by org policy per action type: none, single, or dual approval. Every
        decision writes an event; denials require a reason and are evidence.
      </p>

      <Tabs value={view} onValueChange={(value) => setView(value as View)} className="shrink-0">
        <TabsList aria-label="Approval views">
          {VIEW_TABS.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {query.isLoading && <p className="shrink-0 text-sm text-muted-foreground">Loading…</p>}
      {query.isError && (
        <p className="shrink-0 text-sm text-destructive">Failed to load approvals.</p>
      )}

      {!query.isLoading && rows.length === 0 && (
        <p className="shrink-0 text-sm text-muted-foreground">
          {view === "pending" ? "No approvals waiting on a decision." : "No decided approvals yet."}
        </p>
      )}

      {rows.length > 0 && (
        // Shadow, matching every other list page's table wrapper (People,
        // Access, Archive, Audit, Machines) — see Card's own comment for the
        // exact value and why there's no border alongside it. flex-1 min-h-0
        // + the Table override fill remaining height instead of a flat vh cap.
        <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
          <Table containerClassName="h-full max-h-none">
            <TableHeader>
              <TableRow>
                <Th icon={User}>Requester</Th>
                <Th icon={Zap}>Action</Th>
                <Th icon={TargetGlyph}>Target</Th>
                <Th icon={MessageSquare}>Reason</Th>
                <Th icon={Gauge}>Mode</Th>
                <Th icon={CheckSquare}>Decisions</Th>
                {view === "pending" ? (
                  <Th icon={Clock}>Expires</Th>
                ) : (
                  <>
                    <Th icon={Tag}>Status</Th>
                    <Th icon={Clock}>Decided</Th>
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
                    <TableCell>
                      {/* Every other person-identifying column in the app leads with a
                          PersonAvatar (People's Email, Access's Person/Elevation columns,
                          Machines' Owner) — Requester was the one still plain text. */}
                      <div className="flex items-center gap-2">
                        <PersonAvatar name={approval.requestedByName} />
                        {approval.requestedByName}
                      </div>
                    </TableCell>
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
        </div>
      )}
    </div>
  );
}
