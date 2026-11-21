import { useId, useState } from "react";
import { toast } from "sonner";

import {
  type OrgPackageEntry,
  type UpdateOrgPackagesResult,
  useAddOrgPackage,
  useOrgPackages,
  useRemoveOrgPackage,
  useSetOrgPackageSetting,
} from "@/api/organisation";
import { PackageSettingSelect } from "@/components/package-setting-select";
import { PageLoader } from "@/components/page-loader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PACKAGE_SETTING_LABELS,
  type PackageSetting,
  describeSettingChange,
  settingUnavailableReason,
} from "@/lib/package-setting";

/**
 * Org-level package manifest defaults (see docs/inheritance.md's
 * "Package manifest" section). Distinct from the machine-detail page's manifest
 * editor (`routes/machines/machine-detail-page.tsx`), which only
 * *overrides* an already-resolved entry for one machine — this card is the
 * only place that creates or removes an org-scoped entry at all. A pinned
 * entry here cannot be overridden by a machine below it (a 422 from
 * `PATCH /api/v1/organisation/packages` / `.../machines/:id/packages`, never
 * a silent no-op at reconcile).
 */
/** Tells the person what a setting change did: applied, or waiting for an approver. */
function toastSettingChange(
  packageName: string,
  setting: PackageSetting,
  result: UpdateOrgPackagesResult,
) {
  const outcome = describeSettingChange(packageName, setting, result.ensureApprovals);
  const show = outcome.kind === "success" ? toast.success : toast.error;
  show(outcome.title, outcome.description ? { description: outcome.description } : undefined);
}

export function OrgPackageManifestCard() {
  const packagesQuery = useOrgPackages();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Package manifest defaults</CardTitle>
        <CardDescription>
          The org-wide default manifest. Any machine without its own entry (or override) for a
          package resolves to what's declared here — lowest level wins. Ensure installed makes
          Cloudable install a package on every machine that is missing it. Ensure latest version
          also updates it. Both need an approval first.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {packagesQuery.isPending && <PageLoader size="sm" label="Loading package manifest" />}
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
  const setSetting = useSetOrgPackageSetting();
  const setting = entry.setting ?? "allowed";

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{entry.packageName}</span>
        <span className="font-mono text-sm text-muted-foreground">{entry.versionPin ?? "any"}</span>
        {entry.pinned && <Badge variant="outline">pinned</Badge>}
        {entry.partOf && (
          <span className="text-xs text-muted-foreground">part of {entry.partOf}</span>
        )}
        {entry.description && (
          <span className="text-xs text-muted-foreground">· {entry.description}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <PackageSettingSelect
          value={setting}
          onChange={(next) => {
            if (next === setting) return;
            setSetting.mutate(
              { packageName: entry.packageName, setting: next },
              { onSuccess: (result) => toastSettingChange(entry.packageName, next, result) },
            );
          }}
          packageName={entry.packageName}
          versionPin={entry.versionPin}
          disabled={setSetting.isPending}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => removePackage.mutate(entry.packageName)}
          disabled={removePackage.isPending}
        >
          {removePackage.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}

function AddPackageForm({ existing }: { existing: OrgPackageEntry[] }) {
  const addPackage = useAddOrgPackage();
  const nameId = useId();
  const versionId = useId();
  const pinnedId = useId();
  const partOfId = useId();
  const descriptionId = useId();
  const settingId = useId();

  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("");
  const [pinned, setPinned] = useState(false);
  const [partOf, setPartOf] = useState("");
  const [description, setDescription] = useState("");
  const [setting, setSetting] = useState<PackageSetting>("allowed");

  const trimmedName = packageName.trim();
  const trimmedVersion = versionPin.trim() === "" ? null : versionPin.trim();
  const isDuplicate = existing.some((entry) => entry.packageName === trimmedName);
  // The setting picked first can stop fitting once a name or pin is typed after it.
  const settingProblem = settingUnavailableReason(setting, {
    packageName: trimmedName,
    versionPin: trimmedVersion,
  });
  const canAdd =
    trimmedName !== "" && !isDuplicate && settingProblem === null && !addPackage.isPending;

  function submit() {
    if (!canAdd) return;
    const added = { name: trimmedName, setting };
    addPackage.mutate(
      {
        packageName: trimmedName,
        versionPin: trimmedVersion,
        pinned,
        ...(partOf.trim() === "" ? {} : { partOf: partOf.trim() }),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        setting,
      },
      {
        onSuccess: (result) => {
          setPackageName("");
          setVersionPin("");
          setPinned(false);
          setPartOf("");
          setDescription("");
          setSetting("allowed");
          // An ensure setting waits for an approval, and the package is not added until then.
          if (added.setting !== "allowed") toastSettingChange(added.name, added.setting, result);
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
            placeholder="docker or npm:playwright"
            className="w-52"
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
        <div className="flex flex-col gap-1">
          <label htmlFor={partOfId} className="text-xs text-muted-foreground">
            Part of
          </label>
          <Input
            id={partOfId}
            value={partOf}
            onChange={(event) => setPartOf(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="none"
            className="w-44"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={descriptionId} className="text-xs text-muted-foreground">
            Why
          </label>
          <Input
            id={descriptionId}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="Defender, installed by Azure"
            maxLength={500}
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={settingId} className="text-xs text-muted-foreground">
            Setting
          </label>
          <PackageSettingSelect
            id={settingId}
            value={setting}
            onChange={setSetting}
            packageName={trimmedName}
            versionPin={trimmedVersion}
            className="h-10"
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
      {settingProblem && trimmedName !== "" && (
        <p className="text-xs text-destructive">
          {PACKAGE_SETTING_LABELS[setting]} is not possible here: {settingProblem}.
        </p>
      )}
    </div>
  );
}
