import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Calendar, Clock, DollarSign, Scale, Server } from "lucide-react";

import { type ArchivedSnapshot, useArchivedSnapshots } from "@/api/archive";
import { type Machine, listMachines, machinesKeys } from "@/api/machines";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ARCHIVED_MACHINE_STATES } from "@/routes/machines/machine-state";

import { LegalHoldDialog } from "./legal-hold-dialog";
import { RetentionStatus, formatBytes, formatDate } from "./snapshot-format";

interface ArchivedMachineRow {
  machine: Machine;
  /** The snapshot `archiveMachine()` took when this machine was archived — this row's
   * governance object for retention/legal hold. Earlier upgrade/manual snapshots from the
   * machine's live days (if any) live on its own Snapshots tab, not summarized here. */
  snapshot: ArchivedSnapshot | undefined;
  snapshotCount: number;
}

export function ArchivePage() {
  const machinesQuery = useQuery({ queryKey: machinesKeys.list(), queryFn: listMachines });
  const {
    data: snapshots,
    isLoading: snapshotsLoading,
    isError: snapshotsError,
  } = useArchivedSnapshots();

  const isLoading = machinesQuery.isPending || snapshotsLoading;
  const isError = machinesQuery.isError || snapshotsError;

  const rows: ArchivedMachineRow[] = (machinesQuery.data ?? [])
    .filter((machine) => ARCHIVED_MACHINE_STATES.has(machine.state))
    .map((machine) => {
      const machineSnapshots = (snapshots ?? []).filter((s) => s.machineId === machine.id);
      const archiveSnapshot = machineSnapshots
        .filter((s) => s.trigger === "archive")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      return { machine, snapshot: archiveSnapshot, snapshotCount: machineSnapshots.length };
    });

  return (
    // h-full min-h-0 + the Card below: bounds this page to `main`'s real
    // available height so the table has a real ceiling to shrink against
    // instead of an arbitrary vh fraction — see machines-page.tsx's comment
    // on the same pattern.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-1">
        <h1 className="text-xl font-semibold">Archive</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Machines are archived, never deleted. This page governs retention and legal hold across
          the fleet — restoring an archived machine happens from its own machine page.
        </p>
      </div>

      <Card className="flex min-h-0 flex-col">
        <CardHeader className="shrink-0">
          <CardTitle>Archived machines</CardTitle>
          <CardDescription>
            One row per archived machine, keyed to the snapshot taken when it was archived. Region
            and size are inherited from that snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0">
          {isLoading && <p className="text-sm text-muted-foreground">Loading archived machines…</p>}
          {isError && <p className="text-sm text-destructive">Failed to load archived machines.</p>}
          {!isLoading && !isError && rows.length === 0 && (
            <EmptyState
              icon={Archive}
              title="No archived machines"
              description="Machines you archive will appear here with their retention countdown."
            />
          )}
          {!isLoading && !isError && rows.length > 0 && (
            <Table containerClassName="h-full max-h-none">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Server} />
                      Machine
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Calendar} />
                      Archived
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Clock} />
                      Retention
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Scale} />
                      Legal hold
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={DollarSign} />
                      Projected cost
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ machine, snapshot, snapshotCount }) => (
                  <TableRow key={machine.id}>
                    <TableCell>
                      <Link
                        to="/machines/$machineId"
                        params={{ machineId: machine.id }}
                        className="flex flex-col text-primary hover:underline"
                      >
                        <span className="font-medium">{machine.name}</span>
                        <span className="font-mono text-xs text-muted-foreground no-underline">
                          {snapshot
                            ? `${snapshot.region} · ${formatBytes(snapshot.sizeBytes)}`
                            : machine.region}
                          {snapshotCount > 1 ? ` · ${snapshotCount} snapshots` : ""}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {snapshot ? formatDate(snapshot.createdAt) : "—"}
                    </TableCell>
                    <TableCell>
                      {snapshot ? (
                        <RetentionStatus snapshot={snapshot} />
                      ) : (
                        <span className="text-sm text-muted-foreground">No snapshot on record</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {snapshot ? (
                        <LegalHoldDialog snapshot={snapshot} />
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {snapshot ? (
                        <div className="flex flex-col">
                          <span className="text-sm">${snapshot.projectedCostUsd.toFixed(2)}</span>
                          <span className="text-xs text-muted-foreground">
                            estimate, not a bill
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
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
