import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

import {
  type AccessMethodsEnabled,
  type ManifestEntry,
  ManifestOverrideError,
  getMachine,
  getMachineAccessMethodsEnabled,
  getMachineDrift,
  getMachineManifest,
  getMachinePersistentPaths,
  machinesKeys,
  overrideAccessMethodsEnabled,
  overrideManifestEntry,
  overridePersistentPaths,
} from "@/api/machines";
import { Freshness } from "@/components/freshness";
import { LineageGutter } from "@/components/lineage-gutter";
import { SettingRow } from "@/components/setting-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { MACHINE_STATE_BADGE_VARIANT, MACHINE_STATE_LABEL } from "./machine-state";

function formatAccessMethods(methods: AccessMethodsEnabled | null | undefined): string {
  const enabled: string[] = [];
  if (methods?.webTerminal) enabled.push("web terminal");
  if (methods?.ssh) enabled.push("ssh");
  return enabled.length > 0 ? enabled.join(", ") : "none";
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
  const persistentPathsQuery = useQuery({
    queryKey: machinesKeys.persistentPaths(machineId),
    queryFn: () => getMachinePersistentPaths(machineId),
  });
  const accessMethodsQuery = useQuery({
    queryKey: machinesKeys.accessMethodsEnabled(machineId),
    queryFn: () => getMachineAccessMethodsEnabled(machineId),
  });

  const [editingPackage, setEditingPackage] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState("");
  const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});

  const [editingPersistentPaths, setEditingPersistentPaths] = useState(false);
  const [draftPaths, setDraftPaths] = useState("");
  const [persistentPathsError, setPersistentPathsError] = useState<string | null>(null);

  const persistentPathsMutation = useMutation({
    mutationFn: (paths: string[]) => overridePersistentPaths(machineId, paths),
    onSuccess: () => {
      setEditingPersistentPaths(false);
      setPersistentPathsError(null);
      void queryClient.invalidateQueries({ queryKey: machinesKeys.persistentPaths(machineId) });
    },
    onError: (err) => {
      setPersistentPathsError(err instanceof Error ? err.message : "Override failed.");
    },
  });

  const [editingAccessMethods, setEditingAccessMethods] = useState(false);
  const [draftAccessMethods, setDraftAccessMethods] = useState<AccessMethodsEnabled>({
    webTerminal: true,
    ssh: true,
  });
  const [accessMethodsError, setAccessMethodsError] = useState<string | null>(null);

  const accessMethodsMutation = useMutation({
    mutationFn: (next: AccessMethodsEnabled) => overrideAccessMethodsEnabled(machineId, next),
    onSuccess: () => {
      setEditingAccessMethods(false);
      setAccessMethodsError(null);
      void queryClient.invalidateQueries({
        queryKey: machinesKeys.accessMethodsEnabled(machineId),
      });
    },
    onError: (err) => {
      setAccessMethodsError(err instanceof Error ? err.message : "Override failed.");
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
          <CardTitle>Persistent paths</CardTitle>
          <CardDescription>
            Disposable — these paths survive an OS reimage/upgrade; the OS does not (spec §7).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {persistentPathsQuery.isPending && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {persistentPathsQuery.isError && (
            <p className="text-sm text-destructive">Failed to load persistent paths.</p>
          )}
          {persistentPathsQuery.data && (
            <>
              <SettingRow
                label="Paths"
                value={
                  persistentPathsQuery.data.value.length > 0
                    ? persistentPathsQuery.data.value.join(", ")
                    : "none"
                }
                source={persistentPathsQuery.data.source}
                onOverride={() => {
                  setDraftPaths(persistentPathsQuery.data?.value.join(", ") ?? "");
                  setEditingPersistentPaths(true);
                }}
              />
              <LineageGutter source={persistentPathsQuery.data.source} viewing="machine" />
              {editingPersistentPaths && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      value={draftPaths}
                      onChange={(event) => setDraftPaths(event.target.value)}
                      placeholder="/data, /etc/myapp"
                      aria-label="Persistent paths, comma-separated"
                    />
                    <Button
                      size="sm"
                      onClick={() =>
                        persistentPathsMutation.mutate(
                          draftPaths
                            .split(",")
                            .map((path) => path.trim())
                            .filter((path) => path.length > 0),
                        )
                      }
                      disabled={persistentPathsMutation.isPending}
                    >
                      Save override
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingPersistentPaths(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                  {persistentPathsError && (
                    <p className="text-xs text-destructive">{persistentPathsError}</p>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Access methods</CardTitle>
          <CardDescription>
            Admin-disablable at any level; disabling web terminal ends live sessions immediately,
            not merely new ones (spec §11.1).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {accessMethodsQuery.isPending && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {accessMethodsQuery.isError && (
            <p className="text-sm text-destructive">Failed to load access methods.</p>
          )}
          {accessMethodsQuery.data && (
            <>
              <SettingRow
                label="Enabled methods"
                value={formatAccessMethods(accessMethodsQuery.data.value)}
                source={accessMethodsQuery.data.source}
                onOverride={() => {
                  if (accessMethodsQuery.data) setDraftAccessMethods(accessMethodsQuery.data.value);
                  setEditingAccessMethods(true);
                }}
              />
              <LineageGutter source={accessMethodsQuery.data.source} viewing="machine" />
              {editingAccessMethods && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draftAccessMethods.webTerminal}
                        onChange={(event) =>
                          setDraftAccessMethods((prev) => ({
                            ...prev,
                            webTerminal: event.target.checked,
                          }))
                        }
                      />
                      Web terminal
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draftAccessMethods.ssh}
                        onChange={(event) =>
                          setDraftAccessMethods((prev) => ({ ...prev, ssh: event.target.checked }))
                        }
                      />
                      SSH
                    </label>
                    <Button
                      size="sm"
                      onClick={() => accessMethodsMutation.mutate(draftAccessMethods)}
                      disabled={accessMethodsMutation.isPending}
                    >
                      Save override
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingAccessMethods(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                  {accessMethodsError && (
                    <p className="text-xs text-destructive">{accessMethodsError}</p>
                  )}
                </div>
              )}
            </>
          )}
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
    </div>
  );
}
