import { useId, useState } from "react";

import {
  type OrgPackageEntry,
  useAddOrgPackage,
  useOrgPackages,
  useRemoveOrgPackage,
} from "@/api/organisation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Org-level package manifest defaults (spec.md §6, docs/inheritance.md
 * "Package manifest"). Distinct from the machine-detail page's manifest
 * editor (`routes/machines/machine-detail-page.tsx`), which only
 * *overrides* an already-resolved entry for one machine — this card is the
 * only place that creates or removes an org-scoped entry at all. A pinned
 * entry here cannot be overridden by a machine below it (a 422 from
 * `PATCH /api/v1/organisation/packages` / `.../machines/:id/packages`, never
 * a silent no-op at reconcile).
 */
export function OrgPackageManifestCard() {
  const packagesQuery = useOrgPackages();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Package manifest defaults</CardTitle>
        <CardDescription>
          The org-wide default manifest. Any machine without its own entry (or override) for a
          package resolves to what's declared here — lowest level wins (docs/spec.md §5-6).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {packagesQuery.isPending && (
          <p className="text-sm text-muted-foreground">Loading package manifest…</p>
        )}
        {packagesQuery.isError && (
          <p className="text-sm text-destructive">Failed to load the org package manifest.</p>
        )}
        {packagesQuery.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No org-level packages declared yet.</p>
        )}
        {packagesQuery.data && packagesQuery.data.length > 0 && (
          <div className="flex flex-col">
            {packagesQuery.data.map((entry) => (
              <PackageRow key={entry.packageName} entry={entry} />
            ))}
          </div>
        )}

        <AddPackageForm existing={packagesQuery.data ?? []} />
      </CardContent>
    </Card>
  );
}

function PackageRow({ entry }: { entry: OrgPackageEntry }) {
  // Its own mutation instance (not one shared/hoisted across every row) so
  // each row tracks its own pending state independently — removing two rows
  // in quick succession must not clear the first row's "Removing…" state.
  const removePackage = useRemoveOrgPackage();

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{entry.packageName}</span>
        <span className="font-mono text-sm text-muted-foreground">{entry.versionPin ?? "any"}</span>
        {entry.pinned && <Badge variant="outline">pinned</Badge>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => removePackage.mutate(entry.packageName)}
        disabled={removePackage.isPending}
      >
        {removePackage.isPending ? "Removing…" : "Remove"}
      </Button>
    </div>
  );
}

function AddPackageForm({ existing }: { existing: OrgPackageEntry[] }) {
  const addPackage = useAddOrgPackage();
  const nameId = useId();
  const versionId = useId();
  const pinnedId = useId();

  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("");
  const [pinned, setPinned] = useState(false);

  const trimmedName = packageName.trim();
  const isDuplicate = existing.some((entry) => entry.packageName === trimmedName);
  const canAdd = trimmedName !== "" && !isDuplicate && !addPackage.isPending;

  function submit() {
    if (!canAdd) return;
    addPackage.mutate(
      {
        packageName: trimmedName,
        versionPin: versionPin.trim() === "" ? null : versionPin.trim(),
        pinned,
      },
      {
        onSuccess: () => {
          setPackageName("");
          setVersionPin("");
          setPinned(false);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">Add an org-level package</p>
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
            placeholder="docker"
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
        <div className="flex items-center gap-1.5 pb-1.5">
          <Checkbox
            id={pinnedId}
            checked={pinned}
            onCheckedChange={(checked) => setPinned(checked === true)}
          />
          <Label htmlFor={pinnedId} className="text-sm font-normal">
            Pinned
          </Label>
        </div>
        <Button size="sm" onClick={submit} disabled={!canAdd}>
          {addPackage.isPending ? "Adding…" : "Add package"}
        </Button>
      </div>
      {isDuplicate && (
        <p className="text-xs text-destructive">
          "{trimmedName}" is already declared at the org level — remove it first to replace it.
        </p>
      )}
    </div>
  );
}
