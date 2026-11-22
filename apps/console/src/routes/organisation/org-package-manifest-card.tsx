import { useQueryClient } from "@tanstack/react-query";
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
  type OrgPackageEntry,
  organisationKeys,
  updateOrgPackages,
  useOrgPackages,
  useRemoveOrgPackage,
  useSetOrgPackageSetting,
} from "@/api/organisation";
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

/**
 * The org's package list: what every machine may have, and what Cloudable
 * does about it. A machine without its own entry for a package uses the org's
 * (docs/inheritance.md). A pinned entry cannot be overridden or excluded on a
 * machine. This is the only place org entries are added, changed or removed;
 * it mirrors the machine packages table (`routes/machines/machine-packages-table.tsx`)
 * and shares its add/edit dialog.
 */
export function OrgPackageManifestCard() {
  const queryClient = useQueryClient();
  const packagesQuery = useOrgPackages();
  const [entryDialog, setEntryDialog] = useState<PackageEntryDialogMode | null>(null);
  const [removing, setRemoving] = useState<OrgPackageEntry | null>(null);
  const removePackage = useRemoveOrgPackage();

  const entries = packagesQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Packages for every machine</CardTitle>
        <CardDescription>
          Every machine may have these, unless it has its own entry for the package. Ensure
          installed makes Cloudable install a package on every machine missing it. Ensure latest
          version also updates it. Both need an approval first.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEntryDialog({ kind: "add" })}>
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
                    Failed to load the org's packages.
                  </TableCell>
                </TableRow>
              )}
              {packagesQuery.isSuccess && entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                    No packages for every machine yet.
                  </TableCell>
                </TableRow>
              )}
              {entries.map((entry) => (
                <OrgPackageRow
                  key={entry.packageName}
                  entry={entry}
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
                        pinned: entry.pinned,
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
        scope="org"
        save={(entry) => updateOrgPackages({ upserts: [entry] })}
        mode={entryDialog}
        onOpenChange={(open) => {
          if (!open) setEntryDialog(null);
        }}
        takenNames={new Set(entries.map((entry) => entry.packageName))}
        partOfOptions={entries.map((entry) => entry.packageName)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: organisationKeys.packages() });
          void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        }}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{removing?.packageName}" for every machine?</AlertDialogTitle>
            <AlertDialogDescription>
              Machines without their own entry for it no longer allow it. Where it is installed, it
              stays installed and counts as undeclared software until someone uninstalls it.
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
                    toast.success(`"${name}" removed for every machine`);
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
  onEdit,
  onRemove,
}: {
  entry: OrgPackageEntry;
  onEdit: () => void;
  onRemove: () => void;
}) {
  // Its own mutation per row, so one row's pending state never shows on another.
  const setSetting = useSetOrgPackageSetting();
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
          disabled={setSetting.isPending}
        />
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5 text-sm">
          <span className="font-mono text-xs text-muted-foreground">
            {entry.versionPin ?? "any"}
          </span>
          {entry.pinned && <Badge variant="outline">pinned</Badge>}
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
              Remove for every machine…
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
