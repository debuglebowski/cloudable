import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { listMachines, machinesKeys } from "@/api/machines";
import { Freshness } from "@/components/freshness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { AddMachineDialog } from "./add-machine-dialog";
import {
  ARCHIVED_MACHINE_STATES,
  MACHINE_STATE_BADGE_VARIANT,
  MACHINE_STATE_LABEL,
} from "./machine-state";

export function MachinesPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const { data, isPending, isError, error } = useQuery({
    queryKey: machinesKeys.list(),
    queryFn: listMachines,
  });

  const machines = (data ?? []).filter(
    (machine) => showArchived || !ARCHIVED_MACHINE_STATES.has(machine.state),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Machines</h1>
          <p className="text-sm text-muted-foreground">
            Persistent, governed cloud machines this org owns. Archived machines stay here behind a
            filter — Archive owns retention.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            Add machine
          </Button>
        </div>
      </div>

      {isPending && <p className="text-sm text-muted-foreground">Loading machines…</p>}
      {isError && (
        <p className="text-sm text-destructive">
          Failed to load machines{error instanceof Error ? `: ${error.message}` : ""}.
        </p>
      )}

      {!isPending && !isError && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Image</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Last verified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No machines to show.
                </TableCell>
              </TableRow>
            )}
            {machines.map((machine) => (
              <TableRow key={machine.id}>
                <TableCell>
                  <Link
                    to="/machines/$machineId"
                    params={{ machineId: machine.id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {machine.name}
                  </Link>
                </TableCell>
                <TableCell>{machine.region}</TableCell>
                <TableCell>{machine.sizeSku}</TableCell>
                <TableCell>{machine.image}</TableCell>
                <TableCell>
                  <Badge variant={MACHINE_STATE_BADGE_VARIANT[machine.state]}>
                    {MACHINE_STATE_LABEL[machine.state]}
                  </Badge>
                </TableCell>
                <TableCell>
                  {machine.lastVerifiedAt ? (
                    // Machine model only has one timestamp (`lastVerifiedAt`); Freshness
                    // wants an occurred/recorded pair to flag late reporting, so both are
                    // set to the same value here — a deliberate simplification, not real data.
                    <Freshness
                      occurredAt={machine.lastVerifiedAt}
                      recordedAt={machine.lastVerifiedAt}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">not yet verified</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AddMachineDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
