import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  Archive,
  Clock,
  Cpu,
  Disc,
  MapPin,
  Plus,
  Server,
  Type,
  User,
} from "lucide-react";
import { useState } from "react";

import { listMachines, machinesKeys } from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { Freshness } from "@/components/freshness";
import { OsIcon } from "@/components/os-icon";
import { PageHeaderIcon } from "@/components/page-header-icon";
import { PersonAvatar } from "@/components/person-avatar";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    // h-full min-h-0: sizes this page against `main`'s own bounded height
    // (root.tsx) instead of just growing with content — the table wrapper
    // below is the one flex-1 child, so it fills whatever's left under the
    // header rather than capping at a flat vh fraction (direct user
    // feedback: "the table should fill all available space on the screen").
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {/* Exact hex, matching nav-config.ts's own Machines icon color — see its
              comment for where the value came from (the reference product's real,
              ground-truthed sidebar icon color, not Tailwind's stock blue-500). */}
          <PageHeaderIcon
            icon={Server}
            className="bg-[#0090ff]/10 text-[#0090ff] dark:bg-[#59b7ff]/10 dark:text-[#59b7ff]"
          />
          <div>
            <h1 className="text-xl font-semibold">Machines</h1>
            <p className="text-sm text-muted-foreground">
              Persistent, governed cloud machines this org owns. Archived machines stay here behind
              a filter — Archive owns retention.
            </p>
          </div>
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
        // Audit) now carries, per Card's own comment for the exact value and
        // why there's no border alongside it. flex-1 min-h-0 makes this the
        // one child that absorbs whatever height the header didn't use;
        // `containerClassName` overrides Table's own default max-h-[60vh]
        // cap with a real fill (see Table's own comment on that prop).
        <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
          <Table containerClassName="h-full max-h-none">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Type} />
                    Name
                  </span>
                </TableHead>
                {/* Right after Name, ahead of the infra specifics — same ordering as the
                    detail page's own rail (Owner listed first there too, see its comment):
                    who's accountable for a machine outranks its region/size/image. */}
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={User} />
                    Owner
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={MapPin} />
                    Region
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Cpu} />
                    Size
                  </span>
                </TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Disc} />
                    Image
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
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-28" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-16 rounded-md" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-14" />
                    </TableCell>
                  </TableRow>
                ))}
              {!isPending && machines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No machines to show.
                  </TableCell>
                </TableRow>
              )}
              {machines.map((machine) => (
                <TableRow key={machine.id}>
                  <TableCell>
                    {/* A leading identity glyph before the primary column — same
                      convention as People's PersonAvatar-led Email column, and
                      the reference product's own row-leading company/contact
                      avatar (companies.png/records.png). Reuses the exact
                      OsIcon already rendered in this row's own Image column
                      rather than a second, redundant icon choice. */}
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
                  <TableCell>{machine.region}</TableCell>
                  <TableCell>{machine.sizeSku}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <OsIcon image={machine.image} className="size-3.5 shrink-0" />
                      {machine.image}
                    </span>
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
        </div>
      )}
      <AddMachineDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
