import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import type * as React from "react";

import { ACTION_TYPE_LABELS, usePendingApprovalsQuery } from "@/api/approvals";
import { useAuditTimeline, useControlEvidence } from "@/api/audit";
import { listMachines, machinesKeys } from "@/api/machines";
import { listPeople, peopleKeys } from "@/api/people";
import { Freshness } from "@/components/freshness";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { ARCHIVED_MACHINE_STATES, MACHINE_STATE_LABEL } from "./machines/machine-state";

/**
 * Org overview — the landing page. Pulls a one-glance summary from each domain
 * (machines, approvals, compliance, people) plus the two things a returning admin
 * actually wants: what needs a decision right now, and what just happened. Every
 * number here reads from the same hooks/queries the destination page uses, so this
 * never becomes a second source of truth that can drift from the real page.
 */
export function IndexPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Cloudable</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Persistent, governed cloud Linux machines. One per person, provisioned from identity,
          controlled by policy, evidenced for audit.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MachinesStat />
        <ApprovalsStat />
        <ComplianceStat />
        <PeopleStat />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NeedsAttention />
        <RecentActivity />
      </div>
    </div>
  );
}

function StatCard({
  to,
  label,
  value,
  isLoading,
  detail,
}: {
  to: string;
  label: string;
  value: React.ReactNode;
  isLoading: boolean;
  detail: React.ReactNode;
}) {
  return (
    <Link to={to} className="group block">
      {/* Deepen the shadow on hover, not a border — a `border-{color}` utility with
          no `border` width class (the previous approach here) never actually
          renders, so this card gave no real hover feedback at all beyond the
          arrow icon. Shadow-first elevation matches every other interactive
          surface in the app (Card's own comment: a border reads as "boxed in";
          the reference product lifts with shadow depth, not a colored outline). */}
      <Card className="h-full transition-shadow group-hover:shadow-md">
        <CardContent className="flex flex-col gap-1 p-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{label}</span>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </div>
          {isLoading ? (
            <div className="h-7 w-12 animate-pulse rounded bg-muted" />
          ) : (
            <span className="text-2xl font-semibold tabular-nums leading-none">{value}</span>
          )}
          <div className="min-h-4 text-xs text-muted-foreground">{isLoading ? "" : detail}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

function MachinesStat() {
  const { data, isPending } = useQuery({ queryKey: machinesKeys.list(), queryFn: listMachines });
  const machines = (data ?? []).filter((m) => !ARCHIVED_MACHINE_STATES.has(m.state));
  const errorCount = machines.filter((m) => m.state === "error").length;

  return (
    <StatCard
      to="/machines"
      label="Machines"
      isLoading={isPending}
      value={machines.length}
      detail={
        errorCount > 0 ? <span className="text-drift">{errorCount} in error</span> : "all healthy"
      }
    />
  );
}

function ApprovalsStat() {
  const { data, isPending } = usePendingApprovalsQuery();
  const pending = data ?? [];

  return (
    <StatCard
      to="/approvals"
      label="Pending approvals"
      isLoading={isPending}
      value={pending.length}
      detail={pending.length > 0 ? "awaiting decision" : "queue is clear"}
    />
  );
}

function ComplianceStat() {
  const { data, isPending } = useControlEvidence();
  const checks = (data ?? []).flatMap((g) => g.checks);
  const failing = checks.filter((c) => c.status === "fail").length;
  const passing = checks.filter((c) => c.status === "pass").length;

  return (
    <StatCard
      to="/audit"
      label="Compliance checks"
      isLoading={isPending}
      value={`${passing}/${checks.length}`}
      detail={failing > 0 ? <span className="text-drift">{failing} failing</span> : "passing"}
    />
  );
}

function PeopleStat() {
  const { data, isPending } = useQuery({ queryKey: peopleKeys.list(), queryFn: listPeople });
  const people = data ?? [];
  const active = people.filter((p) => p.active).length;

  return (
    <StatCard
      to="/people"
      label="People"
      isLoading={isPending}
      value={active}
      detail={`${people.length - active} deactivated`}
    />
  );
}

/** Mirrors `formatExpiry`'s urgency threshold in the Approvals page (urgent = expired or <30m out) so a request doesn't read as "on fire" here and merely "due soon" there. */
function timeUntil(iso: string): { label: string; urgent: boolean } {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return { label: "expired", urgent: true };
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return { label: `${minutes}m`, urgent: minutes < 30 };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { label: `${hours}h`, urgent: false };
  return { label: `${Math.round(hours / 24)}d`, urgent: false };
}

/**
 * What a returning admin has to act on right now: machines stuck in error, and
 * approvals closest to expiring unactioned. Both link straight to the row that
 * needs the decision rather than just the list page.
 */
function NeedsAttention() {
  const { data: machinesData, isPending: machinesPending } = useQuery({
    queryKey: machinesKeys.list(),
    queryFn: listMachines,
  });
  const { data: approvalsData, isPending: approvalsPending } = usePendingApprovalsQuery();

  const isPending = machinesPending || approvalsPending;
  const erroredMachines = (machinesData ?? []).filter((m) => m.state === "error");
  const urgentApprovals = [...(approvalsData ?? [])]
    .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime())
    .slice(0, 3);

  const itemCount = erroredMachines.length + urgentApprovals.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Needs attention</CardTitle>
        <CardDescription>Machines in error, and approvals closest to expiring.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!isPending && itemCount === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-ok" />
            Nothing needs attention right now.
          </p>
        )}

        {erroredMachines.map((machine) => (
          <Link
            key={machine.id}
            to="/machines/$machineId"
            params={{ machineId: machine.id }}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
          >
            <span className="font-medium">{machine.name}</span>
            <Badge variant="drift">{MACHINE_STATE_LABEL[machine.state]}</Badge>
          </Link>
        ))}

        {urgentApprovals.map((approval) => {
          const expiry = timeUntil(approval.expiresAt);
          return (
            <Link
              key={approval.id}
              to="/approvals"
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
            >
              <span className="flex flex-col">
                <span className="font-medium">{ACTION_TYPE_LABELS[approval.actionType]}</span>
                <span className="text-xs text-muted-foreground">{approval.targetLabel}</span>
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  expiry.urgent ? "text-drift" : "text-muted-foreground",
                )}
              >
                expires {expiry.label}
              </span>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

function RecentActivity() {
  const { data, isPending } = useAuditTimeline();
  const entries = (data ?? []).slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent activity</CardTitle>
        <CardDescription>The latest events on the audit timeline.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isPending && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No events yet.</p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            // border-border/60, matching TableRow's own hairline-not-a-rule divider.
            className="flex flex-col gap-0.5 border-b border-border/60 pb-3 last:border-0 last:pb-0"
          >
            <div className="flex items-center justify-between gap-3">
              <code className="font-mono text-xs text-muted-foreground">{entry.type}</code>
              <Freshness occurredAt={entry.occurredAt} recordedAt={entry.recordedAt} />
            </div>
            <p className="text-sm">{entry.summary}</p>
          </div>
        ))}
        <Link
          to="/audit"
          className="flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
        >
          View full timeline
          <ArrowRight className="size-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
