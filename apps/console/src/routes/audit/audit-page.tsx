import { useState } from "react";

import {
  type AuditTimelineEntry,
  AUDIT_EXPORT_URLS,
  type ControlCheckEvidence,
  type FindingSeverity,
  useAuditTimeline,
  useControlEvidence,
} from "@/api/audit";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ControlStatus } from "@/components/control-status";
import { Freshness } from "@/components/freshness";
import { cn } from "@/lib/utils";

type AuditView = "timeline" | "evidence";

/**
 * Audit — one section, two in-page views (spec §20): the admin timeline and the
 * auditor evidence export. A tab switch, not a nav item or a route change, so both
 * read as one page over the same append-only event log.
 */
export function AuditPage() {
  const [view, setView] = useState<AuditView>("timeline");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Audit</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Every event Cloudable emits, and what it evidences. Timeline is the raw feed; evidence
          export groups the same events by control for an auditor.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Audit view"
        className="inline-flex w-fit items-center rounded-md border border-border bg-muted p-0.5"
      >
        <ViewTab label="Timeline" active={view === "timeline"} onClick={() => setView("timeline")} />
        <ViewTab
          label="Evidence export"
          active={view === "evidence"}
          onClick={() => setView("evidence")}
        />
      </div>

      {view === "timeline" ? <TimelineView /> : <EvidenceExportView />}
    </div>
  );
}

function ViewTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function formatActor(entry: AuditTimelineEntry): string {
  if (entry.actorType === "system") return "system";
  return entry.actorId ?? entry.actorType;
}

function TimelineView() {
  const { data: entries, isLoading } = useAuditTimeline();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
        <CardDescription>Chronological feed of every event, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries?.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <code className="font-mono text-xs text-muted-foreground">{entry.type}</code>
                  </TableCell>
                  <TableCell className="max-w-md">{entry.summary}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatActor(entry)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {entry.machineId ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Freshness occurredAt={entry.occurredAt} recordedAt={entry.recordedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const SEVERITY_VARIANT: Record<FindingSeverity, BadgeProps["variant"]> = {
  high: "destructive",
  medium: "drift",
  low: "outline",
};

function daysOpen(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/** Oldest (earliest) openSince among a non-empty findings list. */
function oldestOpenSince(findings: [ControlCheckEvidence["findings"][number], ...ControlCheckEvidence["findings"]]): string {
  return findings.reduce((oldest, f) => (f.openSince < oldest ? f.openSince : oldest), findings[0].openSince);
}

function CheckRow({ check }: { check: ControlCheckEvidence }) {
  const [firstFinding, ...restFindings] = check.findings;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ControlStatus
          status={check.status}
          label={check.checkLabel}
          {...(firstFinding ? { evidenceHref: `#findings-${check.id}` } : {})}
        />
        {firstFinding && (
          <span className="text-xs text-muted-foreground">
            {check.findings.length} open · oldest {daysOpen(oldestOpenSince([firstFinding, ...restFindings]))}d
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{check.detail}</p>

      {firstFinding && (
        <ul id={`findings-${check.id}`} className="flex flex-col gap-1.5 rounded-md bg-muted/50 p-2.5">
          {check.findings.map((finding) => (
            <li key={finding.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-foreground">{finding.summary}</span>
              <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-muted-foreground">
                <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
                open {daysOpen(finding.openSince)}d
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceExportView() {
  const { data: groups, isLoading } = useControlEvidence();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          Grouped by control, not by time (§19). Cloud-specific detail lives in the raw event
          layer; this is the normalised projection an auditor reads.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline" size="sm">
            <a
              href={AUDIT_EXPORT_URLS.assetInventoryCsv}
              download
              title="Backend export endpoint pending (compliance unit) — may 404 today"
            >
              Asset inventory CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a
              href={AUDIT_EXPORT_URLS.openFindingsCsv}
              download
              title="Backend export endpoint pending (compliance unit) — may 404 today"
            >
              Open findings CSV
            </a>
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups?.map((group) => (
            <Card key={group.id}>
              <CardHeader>
                <CardTitle className="text-base">{group.control}</CardTitle>
                <CardDescription>{group.framework}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {group.checks.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
