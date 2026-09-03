import { useQuery } from "@tanstack/react-query";
import { Clock, FileText, History, Server, User, Zap } from "lucide-react";

import {
  AUDIT_EXPORT_URLS,
  type ControlCheckEvidence,
  SEVERITY_VARIANT,
  daysOpen,
  useAuditTimeline,
  useControlEvidence,
} from "@/api/audit";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { ActorCell } from "@/components/actor-cell";
import { ControlStatus } from "@/components/control-status";
import { Freshness } from "@/components/freshness";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Audit — one section, two in-page views: the admin timeline and the auditor
 * evidence export. A tab switch, not a nav item or a route change, so both
 * read as one page over the same append-only event log.
 */
export function AuditPage() {
  return (
    // h-full min-h-0 + the Tabs below: bounds this page to `main`'s real
    // available height instead of an arbitrary vh fraction — see
    // machines-page.tsx's comment on the same pattern. The Evidence-export
    // tab (a variable-length stack of Cards, not one table) deliberately
    // opts out below and just flows/scrolls normally — this treatment is for
    // "one table is the whole view" tabs.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-1">
        <h1 className="text-xl font-semibold">Audit</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Every event Cloudable emits, and what it evidences. Timeline is the raw feed; evidence
          export groups the same events by control for an auditor.
        </p>
      </div>

      <Tabs defaultValue="timeline" className="flex min-h-0 flex-col">
        {/* self-start: Tabs' own flex-col stretches items to full width by
            default (align-items: stretch) — without this the pill list would
            span the whole page instead of sizing to its two triggers. */}
        <TabsList className="shrink-0 self-start">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="evidence">Evidence export</TabsTrigger>
        </TabsList>
        {/* flex + min-h-0: only on this tab, not "evidence" below —
            TimelineView's own Card shrinks to this tab's real available
            space instead of a flat vh cap. No overflow-hidden here: Card
            already clips its own children, and adding it on this ancestor
            clipped the Card's own box-shadow along with everything else,
            since the shadow renders outside the Card's box but inside this
            container's bounds. */}
        <TabsContent value="timeline" className="flex min-h-0 flex-col">
          <TimelineView />
        </TabsContent>
        <TabsContent value="evidence">
          <EvidenceExportView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TimelineView() {
  const { data: entries, isLoading, isError } = useAuditTimeline();
  // Same query key `machine-detail-page.tsx`/`machines-page.tsx`/`add-machine-dialog.tsx`
  // already use for this exact directory lookup — one shared cache entry app-wide.
  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeopleDirectory,
  });

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="shrink-0">
        <CardTitle className="text-base">Timeline</CardTitle>
        <CardDescription>Chronological feed of every event, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 p-0">
        {isLoading || isError || (entries?.length ?? 0) > 0 ? (
          <Table containerClassName="h-full max-h-none">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Zap} />
                    Event
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={FileText} />
                    Summary
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={User} />
                    Actor
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Server} />
                    Machine
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Clock} />
                    When
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-4 w-36" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-64" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                  </TableRow>
                ))}
              {isError && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-destructive">
                    Failed to load audit events.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                entries?.map((entry) => (
                  // align-top on every cell, not the TableCell default align-middle —
                  // Summary regularly wraps to several lines while Event/Actor/Machine/
                  // When stay single-line; centering those against a multi-line
                  // neighbor left them floating disconnected from their own row's
                  // first line. Harmless everywhere a row's cells already share one
                  // line height (every other table in the app), so scoped to this
                  // table rather than changing TableCell's own default.
                  <TableRow key={entry.id}>
                    <TableCell className="align-top">
                      <code className="font-mono text-xs text-muted-foreground">{entry.type}</code>
                    </TableCell>
                    <TableCell className="max-w-md align-top">{entry.summary}</TableCell>
                    <TableCell className="whitespace-nowrap align-top text-sm">
                      <ActorCell entry={entry} people={peopleQuery.data} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top font-mono text-xs text-muted-foreground">
                      {entry.machineId ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top">
                      <Freshness occurredAt={entry.occurredAt} recordedAt={entry.recordedAt} />
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={History}
            title="No events yet"
            description="Every event Cloudable emits will appear here as it happens."
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Oldest (earliest) openSince among a non-empty findings list. */
function oldestOpenSince(
  findings: [ControlCheckEvidence["findings"][number], ...ControlCheckEvidence["findings"]],
): string {
  return findings.reduce(
    (oldest, f) => (f.openSince < oldest ? f.openSince : oldest),
    findings[0].openSince,
  );
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
            {check.findings.length} open · oldest{" "}
            {daysOpen(oldestOpenSince([firstFinding, ...restFindings]))}d
            {/* An even-sized findings set can median to a half-day (e.g. 2.5)
                — rounded here so it reads as a whole day like every other
                age figure on this page. */}
            {check.medianAgeDays !== null && <> · median {Math.round(check.medianAgeDays)}d</>}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{check.detail}</p>

      {firstFinding && (
        <ul
          id={`findings-${check.id}`}
          className="flex flex-col gap-1.5 rounded-md bg-muted/50 p-2.5"
        >
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
          Grouped by control, not by time. Cloud-specific detail lives in the raw event layer; this
          is the normalised projection an auditor reads.
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
