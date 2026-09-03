import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Clock,
  Cpu,
  Disc,
  FileText,
  History,
  type LucideIcon,
  MapPin,
  User,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { SEVERITY_VARIANT, daysOpen, useAuditTimeline, useComplianceChecks } from "@/api/audit";
import {
  type DriftStatus,
  type ManifestEntry,
  ManifestOverrideError,
  getMachine,
  getMachineDrift,
  getMachineManifest,
  isMachineStale,
  machinesKeys,
  overrideManifestEntry,
} from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { ActorCell } from "@/components/actor-cell";
import { ControlStatus } from "@/components/control-status";
import { Freshness } from "@/components/freshness";
import { LineageGutter } from "@/components/lineage-gutter";
import { OsIcon } from "@/components/os-icon";
import { SettingRow } from "@/components/setting-row";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
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

import { ArchiveMachineDialog } from "./archive-machine-dialog";
import { ConnectTerminalDialog } from "./connect-terminal-dialog";
import {
  ARCHIVED_MACHINE_STATES,
  MACHINE_STATE_BADGE_VARIANT,
  MACHINE_STATE_LABEL,
} from "./machine-state";
import { ReconcileMachineDialog } from "./reconcile-machine-dialog";
import { UpgradeMachineDialog } from "./upgrade-machine-dialog";

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

/** No real per-machine drift-status badge existed anywhere before this page — see
 * `machine-state.ts`'s own `MACHINE_STATE_BADGE_VARIANT` for the precedent this follows. */
const DRIFT_BADGE_VARIANT: Record<DriftStatus, BadgeProps["variant"]> = {
  clean: "ok",
  detected: "drift",
  unknown: "stale",
};

const DRIFT_STATUS_LABEL: Record<DriftStatus, string> = {
  clean: "clean",
  detected: "drift detected",
  unknown: "not yet reported",
};

type DetailTab = "properties" | "manifest" | "drift" | "compliance" | "activity";

// Stable (non-index) keys for the six-check loading skeleton — this app's six v1 checks
// never reorder, but a plain array index survives biome's own line-wrapping less reliably
// than a fixed key set does.
const COMPLIANCE_SKELETON_KEYS = ["skel-1", "skel-2", "skel-3", "skel-4", "skel-5", "skel-6"];

/**
 * Detail is a sub-route (`/machines/$machineId`), not an expandable row: the manifest and
 * drift panels each carry their own query (and, for the manifest, an override form with
 * validation errors), which reads better behind a real URL/back button than packed into a
 * table row.
 */
export function MachineDetailPage() {
  const { machineId } = useParams({ from: "/machines/$machineId" });
  const queryClient = useQueryClient();

  const machineQuery = useQuery({
    queryKey: machinesKeys.detail(machineId),
    queryFn: () => getMachine(machineId),
  });
  const manifestQuery = useQuery({
    queryKey: machinesKeys.manifest(machineId),
    queryFn: () => getMachineManifest(machineId),
  });
  const driftQuery = useQuery({
    queryKey: machinesKeys.drift(machineId),
    queryFn: () => getMachineDrift(machineId),
  });
  // Same query key `add-machine-dialog.tsx` already uses for this exact directory lookup —
  // shares its cache entry rather than fetching the same list twice under two keys.
  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeopleDirectory,
  });
  // Org-wide endpoints — no per-machine drift/compliance/events API exists yet, so
  // Compliance and Activity filter these by `machineId` client-side rather than
  // waiting on a dedicated backend projection.
  const checksQuery = useComplianceChecks();
  const timelineQuery = useAuditTimeline();

  const [editingPackage, setEditingPackage] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState("");
  const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("properties");

  const overrideMutation = useMutation({
    mutationFn: (vars: { packageName: string; nextVersion: string | null }) =>
      overrideManifestEntry(machineId, vars.packageName, vars.nextVersion),
    onSuccess: (_entry, vars) => {
      setOverrideErrors((prev) => {
        const next = { ...prev };
        delete next[vars.packageName];
        return next;
      });
      setEditingPackage(null);
      void queryClient.invalidateQueries({ queryKey: machinesKeys.manifest(machineId) });
      toast.success(`"${vars.packageName}" overridden`);
    },
    onError: (err, vars) => {
      const message =
        err instanceof ManifestOverrideError ? err.body.error.message : "Override failed.";
      setOverrideErrors((prev) => ({ ...prev, [vars.packageName]: message }));
    },
  });

  function startOverride(entry: ManifestEntry) {
    setEditingPackage(entry.package);
    setDraftVersion(entry.version ?? "");
  }

  function submitOverride(entry: ManifestEntry) {
    const trimmed = draftVersion.trim();
    overrideMutation.mutate({
      packageName: entry.package,
      nextVersion: trimmed === "" ? null : trimmed,
    });
  }

  if (machineQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading machine…</p>;
  }
  if (machineQuery.isError || !machineQuery.data) {
    return <p className="text-sm text-destructive">Machine not found.</p>;
  }

  const machine = machineQuery.data;
  const drift = driftQuery.data;
  // Owner is required at creation — a machine has exactly one owner, always a
  // person — but never shown again after that — not `activePeople`-filtered like the create
  // dialog's picker, since a machine's *existing* owner isn't re-validated as still active here.
  const owner = peopleQuery.data?.find((person) => person.id === machine?.ownerPersonId);

  const machineTimeline =
    timelineQuery.data?.filter((entry) => entry.machineId === machineId) ?? [];

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
            onClick={() => setConnectOpen(true)}
          >
            Connect
          </Button>
          <Button variant="outline" size="sm" onClick={() => setReconcileOpen(true)}>
            Reconcile
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
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DetailTab)}>
        <TabsList>
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="drift">Drift</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="properties">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Properties</CardTitle>
              <CardDescription>Identity, region, size, and image.</CardDescription>
            </CardHeader>
            <CardContent>
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
                <PropertyRow icon={MapPin} label="Region" value={machine.region} />
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Package manifest</CardTitle>
              <CardDescription>
                Effective packages after org → template → machine resolution. Lowest level wins; an
                org-pinned entry cannot be overridden below.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {manifestQuery.isPending && (
                <div className="flex flex-col gap-3">
                  {Array.from({ length: 3 }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
                    <div key={i} className="flex items-center justify-between gap-3">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                  ))}
                </div>
              )}
              {manifestQuery.isError && (
                <p className="text-sm text-destructive">Failed to load package manifest.</p>
              )}
              {manifestQuery.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">No packages declared.</p>
              )}
              {manifestQuery.data?.map((entry) => (
                <div key={entry.package} className="border-b border-border/60 py-2 last:border-b-0">
                  <SettingRow
                    label={entry.package}
                    value={entry.version ?? "any"}
                    source={entry.source}
                    onOverride={() => startOverride(entry)}
                  />
                  <div className="flex items-center gap-2 pb-2">
                    {entry.pinned && <Badge variant="outline">pinned</Badge>}
                    {entry.overriddenBelow !== undefined ? (
                      <LineageGutter
                        source={entry.source}
                        viewing="machine"
                        overriddenBelow={entry.overriddenBelow}
                      />
                    ) : (
                      <LineageGutter source={entry.source} viewing="machine" />
                    )}
                  </div>
                  {editingPackage === entry.package && (
                    <div className="flex flex-col gap-1.5 pb-1">
                      <div className="flex items-center gap-2">
                        <Input
                          value={draftVersion}
                          onChange={(event) => setDraftVersion(event.target.value)}
                          placeholder="version (blank = any)"
                          aria-label={`New version for ${entry.package}`}
                          className="max-w-48"
                        />
                        <Button
                          size="sm"
                          onClick={() => submitOverride(entry)}
                          disabled={overrideMutation.isPending}
                        >
                          Save override
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingPackage(null)}>
                          Cancel
                        </Button>
                      </div>
                      {overrideErrors[entry.package] && (
                        <p className="text-xs text-destructive">{overrideErrors[entry.package]}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="drift">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">Drift</CardTitle>
                {!driftQuery.isPending && drift && (
                  <Badge variant={DRIFT_BADGE_VARIANT[drift.status]}>
                    {DRIFT_STATUS_LABEL[drift.status]}
                  </Badge>
                )}
              </div>
              <CardDescription>
                Anything installed outside the manifest, surfaced on reconcile — never
                auto-corrected.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {driftQuery.isPending && <Skeleton className="h-4 w-72" />}
              {driftQuery.isError && (
                <p className="text-sm text-destructive">Failed to load drift status.</p>
              )}
              {drift?.status === "clean" && (
                <p className="text-sm text-muted-foreground">
                  No drift — matches the declared manifest.
                </p>
              )}
              {drift?.status === "unknown" && (
                <p className="text-sm text-muted-foreground">
                  No drift data available yet — this machine hasn't reported a reconcile pass.
                </p>
              )}
              {drift?.status === "detected" && (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="font-medium text-drift">
                    Undeclared software found outside the manifest.
                  </p>
                  {drift.undeclaredPackages && drift.undeclaredPackages.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Undeclared packages
                      </p>
                      <p className="font-mono text-sm">{drift.undeclaredPackages.join(", ")}</p>
                    </div>
                  )}
                  {drift.undeclaredPorts && drift.undeclaredPorts.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Undeclared open ports
                      </p>
                      <p className="font-mono text-sm">{drift.undeclaredPorts.join(", ")}</p>
                    </div>
                  )}
                  {drift.detectedAt && (
                    <Freshness occurredAt={drift.detectedAt} recordedAt={drift.detectedAt} />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="compliance">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compliance</CardTitle>
              <CardDescription>
                Each check's status reflects the org's whole fleet; findings below are filtered to
                this machine.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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

        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
              <CardDescription>
                Chronological feed of every recorded event for this machine, newest first.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {timelineQuery.isPending || timelineQuery.isError || machineTimeline.length > 0 ? (
                <Table>
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
                          <TableHeaderIcon icon={Clock} />
                          When
                        </span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timelineQuery.isPending &&
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
                            <Skeleton className="h-4 w-16" />
                          </TableCell>
                        </TableRow>
                      ))}
                    {timelineQuery.isError && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-destructive">
                          Failed to load activity.
                        </TableCell>
                      </TableRow>
                    )}
                    {!timelineQuery.isPending &&
                      machineTimeline.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="align-top">
                            <code className="font-mono text-xs text-muted-foreground">
                              {entry.type}
                            </code>
                          </TableCell>
                          <TableCell className="max-w-md align-top">{entry.summary}</TableCell>
                          <TableCell className="whitespace-nowrap align-top text-sm">
                            <ActorCell entry={entry} people={peopleQuery.data} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap align-top">
                            <Freshness
                              occurredAt={entry.occurredAt}
                              recordedAt={entry.recordedAt}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  icon={History}
                  title="No recorded events yet"
                  description="Events for this machine will appear here as they happen."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <UpgradeMachineDialog machine={machine} open={upgradeOpen} onOpenChange={setUpgradeOpen} />
      <ReconcileMachineDialog
        machine={machine}
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
      />
      <ConnectTerminalDialog machine={machine} open={connectOpen} onOpenChange={setConnectOpen} />
      <ArchiveMachineDialog machine={machine} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </div>
  );
}
