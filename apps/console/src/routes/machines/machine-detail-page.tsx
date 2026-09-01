import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Clock, Cpu, Disc, type LucideIcon, MapPin, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  type ManifestEntry,
  ManifestOverrideError,
  getMachine,
  getMachineDrift,
  getMachineManifest,
  machinesKeys,
  overrideManifestEntry,
} from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { CollapsibleSection } from "@/components/collapsible-section";
import { Freshness } from "@/components/freshness";
import { LineageGutter } from "@/components/lineage-gutter";
import { OsIcon } from "@/components/os-icon";
import { SettingRow } from "@/components/setting-row";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ConnectTerminalDialog } from "./connect-terminal-dialog";
import { MACHINE_STATE_BADGE_VARIANT, MACHINE_STATE_LABEL } from "./machine-state";
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

  const [editingPackage, setEditingPackage] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState("");
  const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

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
  // Owner is required at creation (invariant #3: "a machine has exactly one owner, always a
  // person") but never shown again after that — not `activePeople`-filtered like the create
  // dialog's picker, since a machine's *existing* owner isn't re-validated as still active here.
  const owner = peopleQuery.data?.find((person) => person.id === machine?.ownerPersonId);

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
        </div>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col">
          <CollapsibleSection
            label="Package manifest"
            description="Effective packages after org → template → machine resolution. Lowest level wins; an org-pinned entry cannot be overridden below (spec §6)."
          >
            {manifestQuery.isPending && (
              <p className="text-sm text-muted-foreground">Loading manifest…</p>
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
          </CollapsibleSection>

          <CollapsibleSection
            label="Drift"
            description="Anything installed outside the manifest, surfaced on reconcile — never auto-corrected (spec §7 allowlist, invariant 5)."
          >
            {driftQuery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
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
                    <p className="text-xs font-medium text-muted-foreground">Undeclared packages</p>
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
          </CollapsibleSection>
        </div>

        {/* Same elevation treatment as Card (see its own comment — shadow +
            dark-mode-only border, this exact surface is the one the live DOM
            was inspected on for the light-mode shadow value): this rail floats
            over the page the same way the reference product's own detail-page
            rail does. Its own "Properties" heading is a CollapsibleSection too
            (count included) — the reference product's rail sections
            (Touchpoints, Properties) are each individually collapsible via the
            same chevron affordance as the main column, not a plain static
            heading, so this rail now speaks the same interaction language as
            the "Package manifest"/"Drift" sections beside it rather than a
            one-off. */}
        <aside className="flex w-full shrink-0 flex-col rounded-2xl bg-card p-4 shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35 lg:w-64">
          <CollapsibleSection label="Properties" count={5}>
            <dl className="flex flex-col gap-3">
              {/* Every machine has exactly one owner, always a person, never omitted or shared
                  (invariant #3) — required at creation (add-machine-dialog.tsx) but, until now,
                  never surfaced again anywhere in the Machines UI. First in the list: who's
                  accountable outranks the infrastructure specifics below it. */}
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
                    // Same single-timestamp simplification as the list page — see its comment.
                    <Freshness
                      occurredAt={machine.lastVerifiedAt}
                      recordedAt={machine.lastVerifiedAt}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">not yet verified</span>
                  )
                }
              />
            </dl>
          </CollapsibleSection>
        </aside>
      </div>

      <UpgradeMachineDialog machine={machine} open={upgradeOpen} onOpenChange={setUpgradeOpen} />
      <ReconcileMachineDialog
        machine={machine}
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
      />
      <ConnectTerminalDialog machine={machine} open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
