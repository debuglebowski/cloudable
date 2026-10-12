import type {
  MachineVulnerabilitiesResponse,
  VulnerabilityCounts,
  VulnerabilityFindingView,
} from "@cloudable/contracts";
import { Link } from "@tanstack/react-router";
import { ShieldCheck, ShieldOff } from "lucide-react";

import { useMachineVulnerabilities } from "@/api/vulnerability-scan";
import { CollapsibleSection } from "@/components/collapsible-section";
import { PageLoader } from "@/components/page-loader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  NOT_A_GUARANTEE,
  SCAN_STATUS_BADGE_VARIANT,
  SCAN_STATUS_EXPLANATION,
  SCAN_STATUS_LABEL,
  SEVERITIES_IN_ORDER,
  SEVERITY_BADGE_VARIANT,
  SEVERITY_LABEL,
  describeFailureReason,
  formatDate,
  formatDateTime,
  formatOpenDays,
  splitFindings,
  totalCount,
  versionChange,
} from "@/lib/vulnerability-scan";

function SeverityBadge({ severity }: { severity: VulnerabilityFindingView["severity"] }) {
  return <Badge variant={SEVERITY_BADGE_VARIANT[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function CountsRow({ counts }: { counts: VulnerabilityCounts }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {SEVERITIES_IN_ORDER.map((severity) => (
        <li key={severity}>
          <Badge variant={counts[severity] > 0 ? SEVERITY_BADGE_VARIANT[severity] : "outline"}>
            {SEVERITY_LABEL[severity]} {counts[severity]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function OpenFindingsTable({ findings }: { findings: VulnerabilityFindingView[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Vulnerability</TableHead>
              <TableHead>Package</TableHead>
              <TableHead>Installed → fixed</TableHead>
              <TableHead>Open for</TableHead>
              <TableHead>Fix available since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {findings.map((finding) => (
              <TableRow key={finding.id}>
                <TableCell>
                  <SeverityBadge severity={finding.severity} />
                </TableCell>
                <TableCell className="font-mono text-xs">{finding.vulnerabilityId}</TableCell>
                <TableCell className="font-mono text-xs">{finding.packageName}</TableCell>
                <TableCell className="font-mono text-xs">{versionChange(finding)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatOpenDays(finding.openDays)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {finding.fixAvailableSince ? formatDate(finding.fixAvailableSince) : "No fix yet"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ResolvedFindingsTable({ findings }: { findings: VulnerabilityFindingView[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Vulnerability</TableHead>
              <TableHead>Package</TableHead>
              <TableHead>Was open for</TableHead>
              <TableHead>Resolved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {findings.map((finding) => (
              <TableRow key={finding.id}>
                <TableCell>
                  <SeverityBadge severity={finding.severity} />
                </TableCell>
                <TableCell className="font-mono text-xs">{finding.vulnerabilityId}</TableCell>
                <TableCell className="font-mono text-xs">{finding.packageName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatOpenDays(finding.openDays)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(finding.resolvedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Which of the four "nothing to list" situations this is, in words. */
function noFindingsCopy(data: MachineVulnerabilitiesResponse): {
  title: string;
  description: string;
} {
  if (data.lastScan) {
    return {
      title: "No known vulnerabilities in the last scan",
      description:
        "That means nothing known was found in this machine's operating system packages. It does not mean the machine is secure.",
    };
  }
  return {
    title: "No results yet",
    description: "Findings appear here after the machine's first scan.",
  };
}

function DisabledState() {
  return (
    <Card>
      <CardContent className="pt-4">
        <EmptyState
          icon={ShieldOff}
          title="Scanning is off"
          description={SCAN_STATUS_EXPLANATION.disabled}
        />
        <div className="flex justify-center pb-4">
          <Link to="/organisation" className="text-sm text-primary hover:underline">
            Go to Organisation
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One machine's vulnerability findings: where it stands, the last scan, and the findings.
 *
 * Reads `GET /api/v1/machines/:id/vulnerabilities`. A machine the scanner has not reached
 * (scanning off, never scanned, stopped) gets its own plain sentence rather than an empty table,
 * and every state repeats that no findings is not a guarantee.
 */
export function MachineVulnerabilitiesTab({ machineId }: { machineId: string }) {
  const query = useMachineVulnerabilities(machineId);

  if (query.isPending) return <PageLoader size="sm" label="Loading vulnerabilities" />;
  if (query.isError || !query.data) {
    return <p className="text-sm text-destructive">Couldn't load vulnerabilities.</p>;
  }

  const data = query.data;
  if (data.status === "disabled" && !data.lastScan) return <DisabledState />;

  const { open, resolved } = splitFindings(data.findings);
  const scannerText = data.installedScanner
    ? `${data.installedScanner.name} ${data.installedScanner.version}`
    : data.lastScan
      ? `${data.lastScan.scanner} ${data.lastScan.scannerVersion ?? ""}`.trim()
      : "Not installed";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={SCAN_STATUS_BADGE_VARIANT[data.status]}>
              {SCAN_STATUS_LABEL[data.status]}
            </Badge>
            <p className="text-sm text-muted-foreground">{SCAN_STATUS_EXPLANATION[data.status]}</p>
          </div>

          {data.lastFailure && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              The latest scan, on {formatDateTime(data.lastFailure.finishedAt)}, did not finish.{" "}
              {describeFailureReason(data.lastFailure.failureReason)}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fact label="Last scan">
              {data.lastScan ? formatDateTime(data.lastScan.finishedAt) : "Never"}
            </Fact>
            <Fact label="Scanner">{scannerText}</Fact>
            <Fact label="Database built">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {data.lastScan?.dbBuiltAt ? formatDate(data.lastScan.dbBuiltAt) : "Unknown"}
                {data.dbStale && <Badge variant="drift">Out of date</Badge>}
              </span>
            </Fact>
            <Fact label="Open findings">
              {totalCount(data.open.counts)} open, {data.open.fixable} with a fix
            </Fact>
          </dl>

          {data.dbStale && (
            <p className="text-sm text-muted-foreground">
              The vulnerability database behind the last scan is more than 7 days old. A scan with
              an old database misses what was published since, so it does not count as up to date.
            </p>
          )}
          {data.lastScan?.truncated && (
            <p className="text-sm text-muted-foreground">
              This machine has more findings than one scan report can carry. The list below is cut
              short.
            </p>
          )}

          <CountsRow counts={data.open.counts} />
          <p className="text-xs text-muted-foreground">{NOT_A_GUARANTEE}</p>
        </CardContent>
      </Card>

      {open.length > 0 ? (
        <OpenFindingsTable findings={open} />
      ) : data.status !== "never_scanned" || data.lastScan ? (
        <Card>
          <CardContent className="pt-4">
            <EmptyState
              icon={ShieldCheck}
              title={noFindingsCopy(data).title}
              description={noFindingsCopy(data).description}
              className="py-8"
            />
          </CardContent>
        </Card>
      ) : null}

      {resolved.length > 0 && (
        <CollapsibleSection label="Resolved findings" count={resolved.length} defaultOpen={false}>
          <ResolvedFindingsTable findings={resolved} />
        </CollapsibleSection>
      )}
    </div>
  );
}
