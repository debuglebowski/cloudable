import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";

import {
  type ManifestEntry,
  type ManifestHistoryEntry,
  type ManifestHistoryState,
  ManifestOverrideError,
  getMachineManifest,
  getMachineManifestHistory,
  machinesKeys,
  updateMachinePackages,
} from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { ActorCell } from "@/components/actor-cell";
import { Freshness } from "@/components/freshness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MachinePackagesTable } from "@/routes/machines/machine-packages-table";

/**
 * The machine layer of the package manifest, and the record of every change to it.
 *
 * Three different edits live here and are deliberately not collapsed into one
 * control, because they resolve differently:
 *
 * - **Override** changes the version of an entry inherited from the org. The
 *   org still declares the package; this machine just wants a different pin.
 * - **Remove** deletes this machine's own row. If the org declares the
 *   package, it comes straight back as inherited — removal means "stop
 *   overriding", not "get rid of it".
 * - **Exclude** writes a row saying the package must not be on this machine,
 *   which beats the org's entry. An excluded package is not part of the
 *   declared install set, so if it turns up installed it reads as undeclared
 *   software and surfaces as drift.
 *
 * Pinning is not offered here. A pin means "cannot be overridden below" and
 * nothing sits below a machine, so it belongs to the org
 * (`routes/organisation/org-package-manifest-card.tsx`). The server still
 * rejects a machine edit that collides with an org pin.
 *
 * The table itself lives in `machine-packages-table.tsx`; this tab is the
 * table, the form for declaring something new, and the change history.
 */
export function MachineManifestTab({ machineId }: { machineId: string }) {
  const queryClient = useQueryClient();

  const manifestQuery = useQuery({
    queryKey: machinesKeys.manifest(machineId),
    queryFn: () => getMachineManifest(machineId),
  });
  const historyQuery = useQuery({
    queryKey: machinesKeys.manifestHistory(machineId),
    queryFn: () => getMachineManifestHistory(machineId),
  });

  const manifest = manifestQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Packages</CardTitle>
          <CardDescription>
            What this machine is allowed to have, and what it actually has. Permission is inherited
            from the org unless this machine overrides it; installing and removing are separate
            actions the machine carries out on its next check-in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <MachinePackagesTable machineId={machineId} />

          <AddPackageForm
            machineId={machineId}
            existing={manifest}
            onDone={() => {
              void queryClient.invalidateQueries({ queryKey: machinesKeys.manifest(machineId) });
              void queryClient.invalidateQueries({
                queryKey: machinesKeys.manifestHistory(machineId),
              });
            }}
          />
        </CardContent>
      </Card>

      <ManifestHistoryCard
        isPending={historyQuery.isPending}
        isError={historyQuery.isError}
        entries={historyQuery.data ?? []}
      />
    </div>
  );
}

function AddPackageForm({
  machineId,
  existing,
  onDone,
}: {
  machineId: string;
  existing: ManifestEntry[];
  onDone: () => void;
}) {
  const nameId = useId();
  const versionId = useId();
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: (entry: { packageName: string; versionPin: string | null }) =>
      updateMachinePackages(machineId, { upserts: [entry] }),
    onSuccess: (_manifest, entry) => {
      setPackageName("");
      setVersionPin("");
      setError(null);
      onDone();
      toast.success(`"${entry.packageName}" declared on this machine`);
    },
    onError: (err) => {
      setError(
        err instanceof ManifestOverrideError
          ? err.body.error.message
          : "Couldn't add that package.",
      );
    },
  });

  const trimmedName = packageName.trim();
  // A name already on the machine's own row is a duplicate; one inherited from
  // the org is not — declaring it here is how you override it.
  const isDuplicate = existing.some(
    (entry) => entry.package === trimmedName && entry.source === "machine",
  );
  const canAdd = trimmedName !== "" && !isDuplicate && !addMutation.isPending;

  function submit() {
    if (!canAdd) return;
    const trimmedVersion = versionPin.trim();
    addMutation.mutate({
      packageName: trimmedName,
      versionPin: trimmedVersion === "" ? null : trimmedVersion,
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">Declare a package on this machine</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-xs text-muted-foreground">
            Package
          </label>
          <Input
            id={nameId}
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="ripgrep"
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={versionId} className="text-xs text-muted-foreground">
            Version pin
          </label>
          <Input
            id={versionId}
            value={versionPin}
            onChange={(event) => setVersionPin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="any"
            className="w-32"
          />
        </div>
        <Button size="sm" onClick={submit} disabled={!canAdd}>
          {addMutation.isPending ? "Adding…" : "Add package"}
        </Button>
      </div>
      {isDuplicate && (
        <p className="text-xs text-destructive">
          "{trimmedName}" is already set on this machine — edit the row above instead.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Renders one side of a change the way the audit summary does. */
function describeState(state: ManifestHistoryState | null): string {
  if (state === null) return "not declared";
  if (state.excluded) return "excluded";
  const version = state.versionPin ?? "any version";
  return state.pinned ? `${version}, pinned` : version;
}

function ManifestHistoryCard({
  isPending,
  isError,
  entries,
}: {
  isPending: boolean;
  isError: boolean;
  entries: ManifestHistoryEntry[];
}) {
  // Same query key the detail page and the add-machine dialog already use for
  // this lookup, so it shares their cache entry rather than refetching.
  const { data: people } = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeopleDirectory,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manifest history</CardTitle>
        <CardDescription>
          Every recorded change to what this machine is declared to run, newest first. Org-scope
          changes are included: they change what this machine resolves to.
        </CardDescription>
      </CardHeader>
      {/* Capped rather than stretched: the card ends where its content does, and a long
          history scrolls inside itself instead of pushing the page. */}
      <CardContent className="max-h-[60vh] overflow-y-auto">
        {isPending && <Skeleton className="h-4 w-48" />}
        {isError && <p className="text-sm text-destructive">Failed to load manifest history.</p>}
        {!isPending && !isError && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No recorded changes yet.</p>
        )}
        <div className="flex flex-col">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 py-2 last:border-b-0"
            >
              <span className="text-sm font-medium">{entry.packageName}</span>
              <Badge variant="outline">{entry.scope}</Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {describeState(entry.previous)} → {describeState(entry.current)}
              </span>
              <div className="ml-auto flex items-center gap-3">
                <ActorCell entry={entry} people={people} />
                <Freshness occurredAt={entry.occurredAt} recordedAt={entry.recordedAt} />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
