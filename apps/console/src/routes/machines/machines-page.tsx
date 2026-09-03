import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Archive, Clock, Plus, Server, Type, User } from "lucide-react";
import { useState } from "react";

import { isMachineStale, listMachines, machinesKeys } from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { Freshness } from "@/components/freshness";
import { OsIcon } from "@/components/os-icon";
import { PersonAvatar } from "@/components/person-avatar";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  // Same query key `machine-detail-page.tsx`/`add-machine-dialog.tsx` already use for this
  // exact directory lookup — one shared cache entry, not a third independent fetch.
  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeopleDirectory,
  });

  const machines = (data ?? []).filter(
    (machine) => showArchived || !ARCHIVED_MACHINE_STATES.has(machine.state),
  );

  function ownerEmail(ownerPersonId: string | null): string {
    if (!ownerPersonId) return "—";
    return peopleQuery.data?.find((person) => person.id === ownerPersonId)?.email ?? ownerPersonId;
  }

  return (
    // h-full min-h-0: bounds this page to `main`'s real available height
    // instead of an arbitrary vh fraction, giving the table wrapper below a
    // real ceiling to shrink against.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Machines</h1>
          <p className="text-sm text-muted-foreground">
            Persistent, governed cloud machines this org owns. Archived machines stay here behind a
            filter — Archive owns retention.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowArchived((value) => !value)}>
            <Archive />
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            Add machine
          </Button>
        </div>
      </div>

      {isError && (
        <p className="text-sm text-destructive">
          Failed to load machines{error instanceof Error ? `: ${error.message}` : ""}.
        </p>
      )}

      {!isError && (
        // Shadow, not a bare table on the page background — same elevation as
        // every other list page's table wrapper (People, Access, Archive,
        // Audit), per Card's own comment for the exact value and why there's
        // no border alongside it. min-h-0, no flex-1: this shrinks (flex's
        // default flex-shrink: 1) to whatever's actually left under the
        // header when content overflows, but never grows past its own
        // content — a short table just collapses instead of stretching into
        // empty space. `containerClassName` swaps Table's own flat
        // max-h-[60vh] cap for a real h-full fill of this bounded box, so the
        // cap tracks the page's real layout instead of a fixed vh fraction.
        <div className="min-h-0 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
          {isPending || machines.length > 0 ? (
            <Table containerClassName="h-full max-h-none">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Type} />
                      Name
                    </span>
                  </TableHead>
                  {/* Right after Name — same ordering as the detail page's own rail
                    (Owner listed first there too, see its comment): who's accountable
                    for a machine outranks its state. */}
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={User} />
                      Owner
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Activity} />
                      State
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={Clock} />
                      Last verified
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending &&
                  Array.from({ length: 5 }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-32" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-16 rounded-md" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-14" />
                      </TableCell>
                    </TableRow>
                  ))}
                {machines.map((machine) => (
                  <TableRow key={machine.id}>
                    <TableCell>
                      {/* A leading identity glyph before the primary column — same
                      convention as People's PersonAvatar-led Email column, and
                      the reference product's own row-leading company/contact
                      avatar (companies.png/records.png). */}
                      <Link
                        to="/machines/$machineId"
                        params={{ machineId: machine.id }}
                        className="flex items-center gap-1.5 font-medium text-primary hover:underline"
                      >
                        <OsIcon image={machine.image} className="size-3.5 shrink-0" />
                        {machine.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {peopleQuery.isPending ? (
                        <Skeleton className="h-4 w-32" />
                      ) : (
                        <div className="flex items-center gap-2">
                          <PersonAvatar name={ownerEmail(machine.ownerPersonId)} />
                          <span className="truncate">{ownerEmail(machine.ownerPersonId)}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={MACHINE_STATE_BADGE_VARIANT[machine.state]}
                        dot={machine.state === "stopped"}
                      >
                        {MACHINE_STATE_LABEL[machine.state]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {machine.lastVerifiedAt ? (
                        <span className="inline-flex items-center gap-1.5">
                          {/* Machine model only has one timestamp (`lastVerifiedAt`); Freshness
                           * wants an occurred/recorded pair to flag late reporting, so both are
                           * set to the same value here — a deliberate simplification, not real data. */}
                          <Freshness
                            occurredAt={machine.lastVerifiedAt}
                            recordedAt={machine.lastVerifiedAt}
                          />
                          {isMachineStale(machine.lastVerifiedAt) && (
                            <Badge variant="stale">Not reporting</Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">not yet verified</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={Server}
              title="No machines yet"
              description="Add a machine to bring it under management."
            />
          )}
        </div>
      )}
      <AddMachineDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
