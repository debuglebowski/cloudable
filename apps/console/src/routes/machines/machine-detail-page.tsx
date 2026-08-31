import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

import {
  type ManifestEntry,
  ManifestOverrideError,
  getMachine,
  getMachineDrift,
  getMachineLoggingTier,
  getMachineManifest,
  machinesKeys,
  overrideMachineLoggingTier,
  overrideManifestEntry,
} from "@/api/machines";
import {
  DEFAULT_LOGGING_TIER,
  LOGGING_TIER_LABELS,
  type LoggingTier,
  organisationKeys,
} from "@/api/organisation";
import { Freshness } from "@/components/freshness";
import { LineageGutter } from "@/components/lineage-gutter";
import { SettingRow } from "@/components/setting-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { LoggingTierDialog } from "../organisation/setting-dialogs";
import { MACHINE_STATE_BADGE_VARIANT, MACHINE_STATE_LABEL } from "./machine-state";

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
  const loggingTierQuery = useQuery({
    queryKey: machinesKeys.loggingTier(machineId),
    queryFn: () => getMachineLoggingTier(machineId),
  });

  const [editingPackage, setEditingPackage] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState("");
  const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});
  const [editingLoggingTier, setEditingLoggingTier] = useState(false);
  const [loggingTierError, setLoggingTierError] = useState<string | null>(null);

  const loggingTierMutation = useMutation({
    mutationFn: (tier: LoggingTier) => overrideMachineLoggingTier(machineId, tier),
    onSuccess: () => {
      setLoggingTierError(null);
      void queryClient.invalidateQueries({ queryKey: machinesKeys.loggingTier(machineId) });
      // The Organisation page's "N machines override this" count
      // (`loggingTierOverrideCount`) is derived from this same write, so it
      // goes stale unless invalidated here too — it has no query of its own
      // running on this page to pick the change up otherwise.
      void queryClient.invalidateQueries({ queryKey: organisationKeys.all });
    },
    onError: (err) => {
      setLoggingTierError(err instanceof Error ? err.message : "Override failed.");
    },
  });

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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/machines" className="text-sm text-muted-foreground hover:underline">
          ← Machines
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-xl font-semibold">{machine.name}</h1>
          <Badge variant={MACHINE_STATE_BADGE_VARIANT[machine.state]}>
            {MACHINE_STATE_LABEL[machine.state]}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {machine.region} · {machine.sizeSku} · {machine.image}
        </p>
        <div className="mt-1">
          {machine.lastVerifiedAt ? (
            // Same single-timestamp simplification as the list page — see its comment.
            <Freshness occurredAt={machine.lastVerifiedAt} recordedAt={machine.lastVerifiedAt} />
          ) : (
            <span className="text-xs text-muted-foreground">not yet verified</span>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Package manifest</CardTitle>
          <CardDescription>
            Effective packages after org → template → machine resolution. Lowest level wins; an
            org-pinned entry cannot be overridden below (spec §6).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col p-0">
          {manifestQuery.isPending && (
            <p className="p-4 text-sm text-muted-foreground">Loading manifest…</p>
          )}
          {manifestQuery.isError && (
            <p className="p-4 text-sm text-destructive">Failed to load package manifest.</p>
          )}
          {manifestQuery.data?.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No packages declared.</p>
          )}
          <div className="px-4">
            {manifestQuery.data?.map((entry) => (
              <div key={entry.package} className="border-b border-border last:border-b-0">
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
                  <div className="flex flex-col gap-1.5 pb-3">
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Drift</CardTitle>
          <CardDescription>
            Anything installed outside the manifest, surfaced on reconcile — never auto-corrected
            (spec §7 allowlist, invariant 5).
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  <p className="text-xs font-medium text-muted-foreground">Undeclared open ports</p>
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

      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>
            Effective tier for this machine — its own override if set, otherwise the org default
            (docs/spec.md §17).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {loggingTierQuery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {loggingTierQuery.isError && (
            <p className="text-sm text-destructive">Failed to load logging tier.</p>
          )}
          {loggingTierQuery.data && (
            <>
              <SettingRow
                label="Logging tier"
                value={LOGGING_TIER_LABELS[loggingTierQuery.data.tier]}
                source={loggingTierQuery.data.source}
                onOverride={() => setEditingLoggingTier(true)}
              />
              <LineageGutter source={loggingTierQuery.data.source} viewing="machine" />
            </>
          )}
          {loggingTierError && <p className="text-xs text-destructive">{loggingTierError}</p>}
        </CardContent>
      </Card>

      <LoggingTierDialog
        open={editingLoggingTier}
        currentTier={loggingTierQuery.data?.tier ?? DEFAULT_LOGGING_TIER}
        onOpenChange={setEditingLoggingTier}
        onSave={async (tier) => {
          await loggingTierMutation.mutateAsync(tier);
        }}
      />
    </div>
  );
}
