import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  type LucideIcon,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import {
  type OrgPackageEdit,
  type OrgPackageEntry,
  type UpdateOrgPackagesResult,
  organisationKeys,
  updateOrgPackages,
  useOrgPackages,
} from "@/api/organisation";
import { profileKeys, updateProfilePackages, useProfile } from "@/api/profiles";
import { PackageEntryDialog, type PackageEntryDialogMode } from "@/components/package-entry-dialog";
import { PackageSettingSelect } from "@/components/package-setting-select";
import { TableHeaderIcon } from "@/components/table-header-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeSettingChange } from "@/lib/package-setting";
import type { PackageSetting } from "@cloudable/contracts";

type ManifestWrite = (input: {
  upserts?: OrgPackageEdit[];
  removals?: string[];
}) => Promise<UpdateOrgPackagesResult>;

/**
 * The org's package list, or a profile's: what every machine (on the profile) may have, and
 * what Cloudable does about it. A machine without its own entry for a package uses the
 * profile's, then the org's (docs/inheritance.md). A locked entry cannot be overridden or
 * excluded below. This is the only place org and profile entries are added, changed or
 * removed; it mirrors the machine packages table
 * (`routes/machines/machine-packages-table.tsx`) and shares its add/edit dialog.
 */
export function OrgPackageManifestCard({
  profileId,
  readOnly = false,
}: {
  /** Show and edit this profile's own entries instead of the org's. */
  profileId?: string;
  /** An archived profile can no longer change. */
  readOnly?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  const orgQuery = useOrgPackages({ enabled: profileId === undefined });
  const profileQuery = useProfile(profileId);
  const packagesQuery =
    profileId === undefined ? orgQuery : { ...profileQuery, data: profileQuery.data?.packages };
  const [entryDialog, setEntryDialog] = useState<PackageEntryDialogMode | null>(null);
  const [removing, setRemoving] = useState<OrgPackageEntry | null>(null);

  const write: ManifestWrite = (input) =>
    profileId === undefined ? updateOrgPackages(input) : updateProfilePackages(profileId, input);
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey:
        profileId === undefined ? organisationKeys.packages() : profileKeys.detail(profileId),
    });
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  };
  const everyMachine = profileId === undefined ? "every machine" : "every machine on this profile";
  const removePackage = useMutation({
    mutationFn: (packageName: string) => write({ removals: [packageName] }),
    onSuccess: invalidate,
    onError: (error) => toast.error("Couldn't remove that package", { description: error.message }),
  });

  const entries = packagesQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {profileId === undefined ? "Packages for every machine" : "Packages for this profile"}
        </CardTitle>
        <CardDescription>
          {profileId === undefined
            ? "Every machine may have these, unless its profile or itself has its own entry for the package."
            : "Every machine on this profile may have these, unless it has its own entry for the package. They add to the org's packages, and replace the org's entry for the same package."}{" "}
          Ensure installed makes Cloudable install a package on every machine missing it. Ensure
          latest version also updates it. Both need an approval first.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex justify-end">
          <Button size="sm" disabled={readOnly} onClick={() => setEntryDialog({ kind: "add" })}>
            <Plus />
            Add package
          </Button>
        </div>

        {/* Same wrapper as the machine packages table: capped, and collapses to its content. */}
        <div className="min-h-0 overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
          <Table containerClassName="h-full max-h-[60vh]">
            <TableHeader>
              <TableRow>
                <Th icon={Package}>Package</Th>
                <Th icon={ShieldCheck}>Permission</Th>
                <Th icon={Box}>Version</Th>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packagesQuery.isPending &&
                [0, 1].map((i) => (
                  <TableRow key={i}>
                    {["w-32", "w-40", "w-20", "w-6"].map((width) => (
                      <TableCell key={width}>
                        <Skeleton className={`h-4 ${width}`} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {packagesQuery.isError && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-destructive">
                    Failed to load the packages.
                  </TableCell>
                </TableRow>
              )}
              {packagesQuery.isSuccess && entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                    No packages for {everyMachine} yet.
                  </TableCell>
                </TableRow>
              )}
              {entries.map((entry) => (
                <OrgPackageRow
                  key={entry.packageName}
                  entry={entry}
                  readOnly={readOnly}
                  setSetting={(packageName, setting) =>
                    write({ upserts: [{ packageName, setting }] }).then((result) => {
                      invalidate();
                      return result;
                    })
                  }
                  onEdit={() =>
                    setEntryDialog({
                      kind: "edit",
                      inherited: false,
                      values: {
                        packageName: entry.packageName,
                        versionPin: entry.versionPin,
                        partOf: entry.partOf ?? null,
                        description: entry.description ?? null,
                        setting: entry.setting ?? "allowed",
                        locked: entry.locked,
                      },
                    })
                  }
                  onRemove={() => setRemoving(entry)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <PackageEntryDialog
        scope={profileId === undefined ? "org" : "profile"}
        save={(entry) => write({ upserts: [entry] })}
        mode={entryDialog}
        onOpenChange={(open) => {
          if (!open) setEntryDialog(null);
        }}
        takenNames={new Set(entries.map((entry) => entry.packageName))}
        partOfOptions={entries.map((entry) => entry.packageName)}
        onSaved={invalidate}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove "{removing?.packageName}" for {everyMachine}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {profileId === undefined
                ? "Machines without their own entry for it no longer allow it, unless their profile does."
                : "Machines on this profile without their own entry for it go back to the org's entry, if the org has one."}{" "}
              Where it is no longer allowed and is installed, it stays installed and counts as
              undeclared software until someone uninstalls it.
              {removing?.setting && removing.setting !== "allowed"
                ? " Cloudable stops ensuring it."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removePackage.isPending}
              onClick={(event) => {
                // Stay open until the request settles; success closes it.
                event.preventDefault();
                if (!removing) return;
                const name = removing.packageName;
                removePackage.mutate(name, {
                  onSuccess: () => {
                    setRemoving(null);
                    toast.success(`"${name}" removed for ${everyMachine}`);
                  },
                });
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function OrgPackageRow({
  entry,
  readOnly,
  setSetting: writeSetting,
  onEdit,
  onRemove,
}: {
  entry: OrgPackageEntry;
  readOnly: boolean;
  setSetting: (packageName: string, setting: PackageSetting) => Promise<UpdateOrgPackagesResult>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  // Its own mutation per row, so one row's pending state never shows on another.
  const setSetting = useMutation({
    mutationFn: (input: { packageName: string; setting: PackageSetting }) =>
      writeSetting(input.packageName, input.setting),
    onError: (error) => toast.error("Couldn't change that package", { description: error.message }),
  });
  const setting = entry.setting ?? "allowed";

  return (
    <TableRow>
      <TableCell className={entry.partOf ? "pl-8 font-medium" : "font-medium"}>
        {entry.partOf && <span className="mr-1 text-muted-foreground">↳</span>}
        {entry.packageName}
        {entry.partOf && (
          <span className="block text-xs font-normal text-muted-foreground">
            part of {entry.partOf}
          </span>
        )}
        {entry.description && (
          <span className="block text-xs font-normal text-muted-foreground">
            {entry.description}
          </span>
        )}
      </TableCell>
      <TableCell>
        <PackageSettingSelect
          value={setting}
          onChange={(next) => {
            if (next === setting) return;
            setSetting.mutate(
              { packageName: entry.packageName, setting: next },
              {
                onSuccess: (result) => {
                  const outcome = describeSettingChange(
                    entry.packageName,
                    next,
                    result.ensureApprovals,
                  );
                  const show = outcome.kind === "success" ? toast.success : toast.error;
                  show(
                    outcome.title,
                    outcome.description ? { description: outcome.description } : undefined,
                  );
                },
              },
            );
          }}
          packageName={entry.packageName}
          versionPin={entry.versionPin}
          disabled={readOnly || setSetting.isPending}
        />
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5 text-sm">
          <span className="font-mono text-xs text-muted-foreground">
            {entry.versionPin ?? "any"}
          </span>
          {entry.locked && <Badge variant="outline">locked</Badge>}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Actions for ${entry.packageName}`}
              disabled={readOnly}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={onRemove}>
              <X />
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function Th({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <TableHead>
      <span className="flex items-center gap-1.5">
        <TableHeaderIcon icon={icon} />
        {children}
      </span>
    </TableHead>
  );
}
