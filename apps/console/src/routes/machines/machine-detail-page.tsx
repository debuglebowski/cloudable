import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Clock,
  Cloud,
  Cpu,
  Disc,
  FolderSearch,
  History,
  type LucideIcon,
  MapPin,
  User,
} from "lucide-react";
import { useState } from "react";

import { type ArchivedSnapshot, useMachineSnapshots } from "@/api/archive";
import { SEVERITY_VARIANT, daysOpen, useComplianceChecks } from "@/api/audit";
import { getMachine, isMachineStale, machinesKeys } from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { ControlStatus } from "@/components/control-status";
import { Freshness } from "@/components/freshness";
import { OsIcon } from "@/components/os-icon";
import { PageLoader } from "@/components/page-loader";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { RestoreDialog } from "@/routes/archive/restore-dialog";
import { RetentionStatus, formatDate, formatSnapshotSize } from "@/routes/archive/snapshot-format";
import { useInspectSnapshot } from "@/routes/archive/use-inspect-snapshot";

import { ArchiveMachineDialog } from "./archive-machine-dialog";
import { BrowseFilesDialog } from "./browse-files-dialog";
import { ConnectTerminalDialog } from "./connect-terminal-dialog";
import {
  MachineActivityPanel,
  MachineActivityToolbar,
  useMachineActivityState,
} from "./machine-activity-tab";
import { MachineManifestTab } from "./machine-manifest-tab";
import {
  ARCHIVED_MACHINE_STATES,
  MACHINE_STATE_BADGE_VARIANT,
  MACHINE_STATE_LABEL,
} from "./machine-state";
import { RestartMachineDialog } from "./restart-machine-dialog";
import { UpgradeMachineDialog } from "./upgrade-machine-dialog";

const SNAPSHOT_TRIGGER_LABEL: Record<ArchivedSnapshot["trigger"], string> = {
  archive: "Archive",
  upgrade: "Pre-upgrade",
  manual: "Manual",
};

/** Right-rail key/value line — this page's only detail view today, so this stays a
 * local helper rather than a shared component (see collapsible-section.tsx's own
 * comment on the same tradeoff). Extract if a second detail page needs it.
 *
 * `icon` names the field's kind, same convention as `TableHeaderIcon` on the list
 * pages' column headers (company.png's rail rows each carry the same small muted
 * glyph before "Parent company"/"Invoices"/"Website Domain") — and reuses the exact
 * same icon per field as the Machines table header (Region/Size/Image/Last
 * verified), so the two views of the same data stay visually paired. */
function PropertyRow({
  icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <TableHeaderIcon icon={icon} />
        {label}
      </dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

type DetailTab = "properties" | "manifest" | "compliance" | "snapshots" | "activity";

// Stable (non-index) keys for the six-check loading skeleton — this app's six v1 checks
// never reorder, but a plain array index survives biome's own line-wrapping less reliably
// than a fixed key set does.
const COMPLIANCE_SKELETON_KEYS = ["skel-1", "skel-2", "skel-3", "skel-4", "skel-5", "skel-6"];

/**
 * Detail is a sub-route (`/machines/$machineId`), not an expandable row: the tabs below carry
 * their own queries and editing surfaces — the Manifest tab alone has a package editor and its
 * own change history (`./machine-manifest-tab.tsx`) — which reads better behind a real URL and
 * back button than packed into a table row.
 */
/**
 * What a non-restorable snapshot shows in place of the Restore action.
 *
 * Three distinct states, kept distinct because they mean different things to whoever is
 * reading: nothing was ever captured, the data was deleted on schedule, or the data went
 * away early and nobody knows why. The full sentence is on the `title`; this is the part
 * that has to fit in a column.
 */
const SNAPSHOT_UNAVAILABLE_LABEL: Record<string, string> = {
  empty: "Nothing captured",
  expired: "Data expired",
  data_missing: "Data missing",
};

export function MachineDetailPage() {
  const { machineId } = useParams({ from: "/machines/$machineId" });

  const machineQuery = useQuery({
    queryKey: machinesKeys.detail(machineId),
    queryFn: () => getMachine(machineId),
  });
  // Same query key `add-machine-dialog.tsx` already uses for this exact directory lookup —
  // shares its cache entry rather than fetching the same list twice under two keys.
  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeopleDirectory,
  });
  // Org-wide endpoint — no per-machine compliance API exists yet, so Compliance
  // filters this by `machineId` client-side rather than waiting on a dedicated
  // backend projection. Packages, Snapshots and Activity each have a real
  // per-machine endpoint of their own.
  const checksQuery = useComplianceChecks();
  const snapshotsQuery = useMachineSnapshots(machineId);
  const { inspect, isPending: inspectPending } = useInspectSnapshot();

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("properties");
  // Lives here, not inside the tab, because its two halves render on either side
  // of the Tabs boundary. `enabled` keeps the fetch lazy: the toolbar is mounted
  // by this page rather than by TabsContent, so Radix unmounting an inactive tab
  // no longer holds the query back on its own.
  const activity = useMachineActivityState(machineId, peopleQuery.data, activeTab === "activity");

  if (machineQuery.isPending) {
    return <PageLoader label="Loading machine" />;
  }
  if (machineQuery.isError || !machineQuery.data) {
    return <p className="text-sm text-destructive">Machine not found.</p>;
  }

  const machine = machineQuery.data;
  // Owner is required at creation — a machine has exactly one owner, always a
  // person — but never shown again after that — not `activePeople`-filtered like the create
  // dialog's picker, since a machine's *existing* owner isn't re-validated as still active here.
  const owner = peopleQuery.data?.find((person) => person.id === machine?.ownerPersonId);

  // The snapshot `archiveMachine()` took when this machine was archived — the header's
  // Restore action mirrors the header's Archive action, same as the Snapshots tab's own
  // per-row restore (which also covers any earlier upgrade/manual snapshot).
  const latestArchiveSnapshot = snapshotsQuery.data
    ?.filter((s) => s.trigger === "archive")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/machines" className="hover:text-foreground hover:underline">
          Machines
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">{machine.name}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <OsIcon image={machine.image} className="size-4" />
        </span>
        <h1 className="text-xl font-semibold">{machine.name}</h1>
        <Badge
          variant={MACHINE_STATE_BADGE_VARIANT[machine.state]}
          dot={machine.state === "stopped"}
        >
          {MACHINE_STATE_LABEL[machine.state]}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={machine.state !== "running"}
            title={
              machine.state !== "running"
                ? "Only a running machine has a live tunnel daemon connection to attach to."
                : undefined
            }
            onClick={() => setFilesOpen(true)}
          >
            Files
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={machine.state !== "running"}
            title={
              machine.state !== "running"
                ? "Only a running machine has a live tunnel daemon connection to attach to."
                : undefined
            }
            onClick={() => setConnectOpen(true)}
          >
            Connect
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={machine.state !== "running"}
            title={
              machine.state !== "running" ? "Only a running machine can be restarted." : undefined
            }
            onClick={() => setRestartOpen(true)}
          >
            Restart
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUpgradeOpen(true)}>
            Upgrade
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={ARCHIVED_MACHINE_STATES.has(machine.state)}
            title={ARCHIVED_MACHINE_STATES.has(machine.state) ? "Already archived." : undefined}
            onClick={() => setArchiveOpen(true)}
          >
            Archive
          </Button>
          {ARCHIVED_MACHINE_STATES.has(machine.state) &&
            (latestArchiveSnapshot?.subState === "restorable" ? (
              <RestoreDialog snapshot={latestArchiveSnapshot} />
            ) : (
              <Button
                size="sm"
                disabled
                // The server's own reason, not one re-derived here. This used to read
                // `expiredAt` alone, which meant a snapshot that captured nothing — or
                // one whose disks have since vanished from the provider — showed a live
                // Restore button over data that is not there.
                title={
                  latestArchiveSnapshot?.restoreUnavailableReason ??
                  "No archive snapshot on record."
                }
              >
                Restore
              </Button>
            ))}
        </div>
      </div>
      {machine.state === "error" && machine.lastError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {machine.lastError}
        </div>
      )}
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DetailTab)}>
        {/* The tab row doubles as the active tab's toolbar. Activity's search and
            filters sit opposite the pills rather than above its table: they act on
            what the tab below shows, and a second full-width bar between the tabs
            and the table pushed the data itself further down the page. Only the
            active tab may fill this slot, and only Activity does today. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="properties">Properties</TabsTrigger>
            <TabsTrigger value="manifest">Manifest</TabsTrigger>
            <TabsTrigger value="compliance">Compliance</TabsTrigger>
            <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          {activeTab === "activity" && <MachineActivityToolbar state={activity} />}
        </div>

        <TabsContent value="properties">
          <Card>
            <CardContent className="pt-4">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {/* Every machine has exactly one owner, always a person, never omitted or
                    shared — required at creation (add-machine-dialog.tsx) but, until now,
                    never surfaced again anywhere in the Machines UI. First in the list: who's
                    accountable outranks the infrastructure specifics beside it. */}
                <PropertyRow
                  icon={User}
                  label="Owner"
                  value={
                    peopleQuery.isPending ? (
                      <span className="text-xs text-muted-foreground">loading…</span>
                    ) : (
                      (owner?.email ?? machine.ownerPersonId ?? "—")
                    )
                  }
                />
                <PropertyRow icon={Cloud} label="Provider" value={machine.provider} />
                {machine.region && (
                  <PropertyRow icon={MapPin} label="Region" value={machine.region} />
                )}
                <PropertyRow icon={Cpu} label="Size" value={machine.sizeSku} />
                <PropertyRow
                  icon={Disc}
                  label="Image"
                  value={
                    <span className="flex items-center gap-1.5">
                      <OsIcon image={machine.image} className="size-3.5 shrink-0" />
                      {machine.image}
                    </span>
                  }
                />
                <PropertyRow
                  icon={Clock}
                  label="Last verified"
                  value={
                    machine.lastVerifiedAt ? (
                      <span className="inline-flex items-center gap-1.5">
                        {/* Same single-timestamp simplification as the list page — see its comment. */}
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
                    )
                  }
                />
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manifest">
          <MachineManifestTab machineId={machineId} />
        </TabsContent>

        <TabsContent value="compliance">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-4">
              {checksQuery.isPending &&
                COMPLIANCE_SKELETON_KEYS.map((key) => (
                  <div
                    key={key}
                    className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
                  >
                    <Skeleton className="h-5 w-44 rounded-full" />
                  </div>
                ))}
              {checksQuery.isError && (
                <p className="text-sm text-destructive">Failed to load compliance checks.</p>
              )}
              {checksQuery.data?.map((check) => {
                const machineFindings = check.findings.filter(
                  (finding) => finding.machineId === machineId,
                );
                return (
                  <div
                    key={check.id}
                    className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <ControlStatus status={check.status} label={check.label} />
                    </div>
                    {machineFindings.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No open findings for this machine.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1.5 rounded-md bg-muted/50 p-2.5">
                        {machineFindings.map((finding) => (
                          <li
                            key={finding.id}
                            className="flex items-center justify-between gap-3 text-xs"
                          >
                            {/* `summary` is built for the org-wide Evidence export view,
                                    where a finding needs its machine id spelled out — here
                                    every finding is already this one machine's, so that
                                    repeated prefix is dropped. */}
                            <span className="text-foreground">
                              {finding.summary.replace(`${finding.machineId}: `, "")}
                            </span>
                            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-muted-foreground">
                              <Badge variant={SEVERITY_VARIANT[finding.severity]}>
                                {finding.severity}
                              </Badge>
                              open {daysOpen(finding.openSince)}d
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="snapshots">
          <Card>
            <CardContent className="p-0">
              {snapshotsQuery.isPending ||
              snapshotsQuery.isError ||
              (snapshotsQuery.data?.length ?? 0) > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trigger</TableHead>
                      <TableHead>
                        <span className="flex items-center gap-1.5">
                          <TableHeaderIcon icon={Clock} />
                          Created
                        </span>
                      </TableHead>
                      <TableHead>Retention</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshotsQuery.isPending &&
                      Array.from({ length: 2 }, (_, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
                        <TableRow key={i}>
                          <TableCell colSpan={5}>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                        </TableRow>
                      ))}
                    {snapshotsQuery.isError && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-destructive">
                          Failed to load snapshots.
                        </TableCell>
                      </TableRow>
                    )}
                    {snapshotsQuery.data?.map((snapshot) => (
                      <TableRow key={snapshot.id}>
                        <TableCell>
                          <Badge variant="outline">
                            {SNAPSHOT_TRIGGER_LABEL[snapshot.trigger]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(snapshot.createdAt)}
                        </TableCell>
                        <TableCell>
                          <RetentionStatus snapshot={snapshot} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatSnapshotSize(snapshot)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            {/* This tab is the only place manual and upgrade snapshots
                                are listed — the Archive page shows one archive-trigger
                                snapshot per archived machine — so without this button a
                                snapshot someone took on purpose could not be opened from
                                the console at all. Greyed WITH the reason rather than
                                hidden, the rule `sub-state.ts` states. */}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={snapshot.subState !== "restorable" || inspectPending}
                              title={snapshot.restoreUnavailableReason ?? undefined}
                              onClick={() => inspect(snapshot.id)}
                            >
                              <FolderSearch />
                              Browse files
                            </Button>
                            {snapshot.subState === "restorable" ? (
                              <RestoreDialog snapshot={snapshot} />
                            ) : (
                              <span
                                className="text-xs text-muted-foreground"
                                title={snapshot.restoreUnavailableReason ?? undefined}
                              >
                                {SNAPSHOT_UNAVAILABLE_LABEL[snapshot.subState]}
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  icon={History}
                  title="No snapshots yet"
                  description="Archiving, upgrading, or manually snapshotting this machine will list them here."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity">
          <MachineActivityPanel state={activity} />
        </TabsContent>
      </Tabs>
      <UpgradeMachineDialog machine={machine} open={upgradeOpen} onOpenChange={setUpgradeOpen} />{" "}
      <ConnectTerminalDialog machine={machine} open={connectOpen} onOpenChange={setConnectOpen} />
      <BrowseFilesDialog machine={machine} open={filesOpen} onOpenChange={setFilesOpen} />
      <RestartMachineDialog machine={machine} open={restartOpen} onOpenChange={setRestartOpen} />
      <ArchiveMachineDialog machine={machine} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </div>
  );
}
