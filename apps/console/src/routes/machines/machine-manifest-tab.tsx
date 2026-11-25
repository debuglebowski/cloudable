import { useQuery } from "@tanstack/react-query";

import {
  type ManifestHistoryEntry,
  type ManifestHistoryState,
  getMachineManifestHistory,
  machinesKeys,
} from "@/api/machines";
import { listPeople as listPeopleDirectory } from "@/api/people-directory";
import { ActorCell } from "@/components/actor-cell";
import { Freshness } from "@/components/freshness";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PACKAGE_SETTING_LABELS } from "@/lib/package-setting";
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
 * table and the change history.
 */
export function MachineManifestTab({
  machineId,
  profileId,
  canEditManifest,
  canRequestActions,
}: {
  machineId: string;
  /** The machine's profile, whose entries it inherits between the org's and its own. */
  profileId: string | null;
  /** Changing what the machine may have: admin only. */
  canEditManifest: boolean;
  /** Asking for an install or a removal: the owner or an admin. Installs wait for an approver. */
  canRequestActions: boolean;
}) {
  const historyQuery = useQuery({
    queryKey: machinesKeys.manifestHistory(machineId),
    queryFn: () => getMachineManifestHistory(machineId),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Packages</CardTitle>
          <CardDescription>
            What this machine is allowed to have, and what it actually has. Each package comes from
            the org or is set on this machine. Installing and removing happen on the machine's next
            check-in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <MachinePackagesTable
            machineId={machineId}
            profileId={profileId}
            canEditPermission={canEditManifest}
            canRequestActions={canRequestActions}
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

/** Renders one side of a change the way the audit summary does. */
export function describeState(state: ManifestHistoryState | null): string {
  if (state === null) return "not declared";
  if (state.excluded) return "excluded";
  const version = state.versionPin ?? "any version";
  const parts = [state.locked ? `${version}, locked` : version];
  if (state.partOf) parts.push(`part of ${state.partOf}`);
  if (state.setting && state.setting !== "allowed") {
    parts.push(PACKAGE_SETTING_LABELS[state.setting]);
  }
  return parts.join(", ");
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
