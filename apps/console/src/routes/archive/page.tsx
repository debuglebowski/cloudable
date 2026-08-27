import { type ArchivedSnapshot, useArchivedSnapshots } from "@/api/archive";
import { Badge } from "@/components/ui/badge";
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

import { LegalHoldDialog } from "./legal-hold-dialog";
import { RestoreDialog } from "./restore-dialog";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`;
}

function daysUntil(iso: string): number {
  // Clamped to zero: once expiresAt has passed there's a documented gap before the hard-delete
  // job sets expiredAt (see api/archive.ts), and a negative count would be misleading there.
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** Retention countdown / expired / legal-hold state for one row. Never hides the "why". */
function RetentionStatus({ snapshot }: { snapshot: ArchivedSnapshot }) {
  if (snapshot.legalHold) {
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant="secondary">Legal hold</Badge>
        <span className="text-xs text-muted-foreground">Exempt from expiry</span>
      </div>
    );
  }

  if (snapshot.expiredAt) {
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant="drift">Expired</Badge>
        <span className="text-xs text-muted-foreground">on {formatDate(snapshot.expiredAt)}</span>
      </div>
    );
  }

  const remaining = daysUntil(snapshot.expiresAt);
  const urgent = remaining <= 5;
  return (
    <div className="flex flex-col gap-0.5">
      <Badge variant={urgent ? "drift" : "ok"}>
        {remaining} day{remaining === 1 ? "" : "s"} left
      </Badge>
      <span className="text-xs text-muted-foreground">expires {formatDate(snapshot.expiresAt)}</span>
    </div>
  );
}

export function ArchivePage() {
  const { data: snapshots, isLoading, isError } = useArchivedSnapshots();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Archive</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Machines are archived, never deleted. This page governs the retention clock and restore
          for archived snapshots — separate from the live Machines list.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Snapshots</CardTitle>
          <CardDescription>
            Volume data plus machine desired state and configuration, captured on archive. Region
            is inherited from the machine.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading archived snapshots…</p>
          )}
          {isError && (
            <p className="text-sm text-destructive">Failed to load archived snapshots.</p>
          )}
          {snapshots && snapshots.length === 0 && (
            <p className="text-sm text-muted-foreground">No archived machines yet.</p>
          )}
          {snapshots && snapshots.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  <TableHead>Archived</TableHead>
                  <TableHead>Retention</TableHead>
                  <TableHead>Legal hold</TableHead>
                  <TableHead>Projected cost</TableHead>
                  <TableHead className="text-right">Restore</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((snapshot) => (
                  <TableRow key={snapshot.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{snapshot.machineName}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {snapshot.region} · {formatBytes(snapshot.sizeBytes)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(snapshot.archivedAt)}
                    </TableCell>
                    <TableCell>
                      <RetentionStatus snapshot={snapshot} />
                    </TableCell>
                    <TableCell>
                      <LegalHoldDialog snapshot={snapshot} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm">${snapshot.projectedCostUsd.toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground">estimate, not a bill</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {snapshot.expiredAt ? (
                        <div className="flex flex-col items-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            title={`Restore unavailable — volume data was hard-deleted on ${formatDate(snapshot.expiredAt)}`}
                          >
                            Restore
                          </Button>
                          <p className="max-w-[220px] text-right text-xs text-muted-foreground">
                            Data hard-deleted after the {snapshot.retentionDays}-day retention
                            period elapsed on {formatDate(snapshot.expiredAt)}. Record and audit
                            history remain.
                          </p>
                        </div>
                      ) : (
                        <div className="flex justify-end">
                          <RestoreDialog snapshot={snapshot} />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
