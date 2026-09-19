import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Calendar, Clock, Lock, LockOpen, Scale, Server } from "lucide-react";

import { type ArchivedSnapshot, useArchivedSnapshots } from "@/api/archive";
import { type Machine, listMachines, machinesKeys } from "@/api/machines";
import { PageLoader } from "@/components/page-loader";
import { TableHeaderIcon } from "@/components/table-header-icon";
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
import { ARCHIVED_MACHINE_STATES } from "@/routes/machines/machine-state";

import { RetentionStatus, formatDate, formatSnapshotSize } from "./snapshot-format";

/** Read-only, and the only kind of legal-hold control this page has. Placing and clearing
 * a hold lives on a machine's own Snapshots tab, where every snapshot is listed rather
 * than just the one archiving took — a manual or upgrade snapshot is retained and billed
 * exactly like an archive one, and could never be put on hold from here. */
function LegalHoldStatus({ legalHold }: { legalHold: boolean }) {
  return legalHold ? (
    <Badge variant="secondary">
      <Lock className="mr-1 size-3" />
      On hold
    </Badge>
  ) : (
    <Badge variant="outline">
      <LockOpen className="mr-1 size-3" />
      Not held
    </Badge>
  );
}

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
          Machines are archived, never deleted. This is the fleet overview: which machines are
          archived, and where each one stands against its retention clock. Everything you can do to
          a snapshot — browse it, restore it, hold it — happens on a machine's own Snapshots tab,
          which lists all of them rather than only the one archiving took.
        </p>
      </div>

      <Card className="flex min-h-0 flex-col">
        <CardContent className="min-h-0 pt-4">
          {isLoading && <PageLoader size="sm" label="Loading archived machines" />}
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
                            ? `${snapshot.region ?? "no region"} · ${snapshot.scope} · ${formatSnapshotSize(snapshot)}`
                            : (machine.region ?? "no region")}
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
                        <LegalHoldStatus legalHold={snapshot.legalHold} />
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
