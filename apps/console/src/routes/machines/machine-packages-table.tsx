import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, CircleSlash, type LucideIcon, Package, ShieldCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import {
  type MachinePackageRow,
  ManifestOverrideError,
  PackageActionError,
  type PackageActionOp,
  type PackageSetting,
  createPackageAction,
  getMachinePackages,
  machinesKeys,
  updateMachinePackages,
} from "@/api/machines";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { refusalReason } from "@/lib/api-client";
import {
  PACKAGE_SETTINGS,
  PACKAGE_SETTING_LABELS,
  describeSettingChange,
  formatNextTry,
  settingUnavailableReason,
} from "@/lib/package-setting";

/**
 * A machine's packages: what it is allowed to have, what it actually has, and
 * the buttons that change either.
 *
 * Permission and installation are separate columns because they are separate
 * facts. A package can be allowed and absent because nobody has installed it
 * yet, or present and disallowed because somebody installed it anyway — which
 * is exactly the case the compliance check exists to catch. Collapsing them
 * into one "status" would hide the interesting half.
 *
 * One Permission column says both whether a package may be here and what
 * Cloudable does about it: Excluded, Allowed, Ensure installed (installed when
 * missing) or Ensure latest version (also kept updated). A dash means nobody
 * declared it. Moving to an ensure value waits for an approval.
 *
 * Base image packages are hidden behind the toggle. A real Ubuntu server image
 * is several hundred packages, and listing them by default buries the handful
 * anyone came here to look at.
 */
export function MachinePackagesTable({
  machineId,
  canEditPermission,
  canRequestActions,
  actions,
}: {
  machineId: string;
  /** Which packages a machine may have is configuration: admin only. */
  canEditPermission: boolean;
  /** Installing and removing: the owner or an admin. */
  canRequestActions: boolean;
  /** Buttons for the bar above the table, right side (the image-packages toggle sits left). */
  actions?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [showBaseline, setShowBaseline] = useState(false);

  const packagesQuery = useQuery({
    queryKey: machinesKeys.packages(machineId),
    queryFn: () => getMachinePackages(machineId),
    // An action lands on the machine a poll later, so the table is stale the
    // moment it is rendered. Refetching keeps a pending row moving without the
    // person reloading the page to find out what happened.
    refetchInterval: (query) =>
      query.state.data?.items.some((row) => row.pendingAction) ? 5_000 : false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: machinesKeys.packages(machineId) });
    void queryClient.invalidateQueries({ queryKey: machinesKeys.manifest(machineId) });
    void queryClient.invalidateQueries({ queryKey: machinesKeys.manifestHistory(machineId) });
  };

  const actionMutation = useMutation({
    mutationFn: (vars: { packageName: string; op: PackageActionOp }) =>
      createPackageAction(machineId, vars.packageName, vars.op),
    onSuccess: (result, vars) => {
      invalidate();
      // An install usually waits for an approver. Nothing is queued until one says yes.
      if (!result.action && result.approval?.status === "pending") {
        toast.success(`Asked to install "${vars.packageName}"`, {
          description: "Waiting for approval. It installs once an approver says yes.",
        });
        return;
      }
      // Deliberately not "installed": the machine has not done anything yet.
      toast.success(
        vars.op === "install"
          ? `Asked this machine to install "${vars.packageName}"`
          : `Asked this machine to remove "${vars.packageName}"`,
      );
    },
    onError: (err) => {
      toast.error("Couldn't request that", {
        description:
          err instanceof PackageActionError
            ? err.body.error.code === "ensured_package"
              ? "This package is set to Ensure, so Cloudable would put it back. Set it to Allowed first."
              : err.body.error.message
            : (refusalReason(err) ?? err.message),
      });
    },
  });

  const permissionMutation = useMutation({
    mutationFn: (vars: { row: MachinePackageRow; target: PermissionValue }) =>
      updateMachinePackages(machineId, { upserts: [permissionEdit(vars.row, vars.target)] }),
    onSuccess: (result, vars) => {
      invalidate();
      const name = vars.row.packageName;
      if (vars.target === "excluded") {
        toast.success(`"${name}" is no longer allowed on this machine`);
        return;
      }
      const outcome = describeSettingChange(name, vars.target, result.ensureApprovals);
      if (result.ensureApprovals.some((approval) => approval.status === "pending")) {
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      }
      const show = outcome.kind === "success" ? toast.success : toast.error;
      show(outcome.title, outcome.description ? { description: outcome.description } : undefined);
    },
    onError: (err) => {
      toast.error("Couldn't change that", {
        description:
          err instanceof ManifestOverrideError
            ? err.body.error.message
            : (refusalReason(err) ?? err.message),
      });
    },
  });

  const allRows = packagesQuery.data?.items ?? [];
  // Image packages and apt-pulled dependencies are hidden together by default:
  // neither is something a person chose, and both run to hundreds of rows.
  const isBackground = (row: MachinePackageRow) =>
    row.isBaseline || (row.installedAsDependency === true && row.permission === null);
  const rows = nestParts(showBaseline ? allRows : allRows.filter((row) => !isBackground(row)));
  const baselineCount = allRows.filter(isBackground).length;
  const neverReported = packagesQuery.data?.lastReportedAt === null;

  return (
    <div className="flex flex-col gap-3">
      {neverReported && !packagesQuery.isPending && (
        <p className="text-sm text-muted-foreground">
          This machine hasn't reported yet, so what's installed is unknown rather than nothing.
        </p>
      )}

      {(actions || baselineCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {baselineCount > 0 ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`show-baseline-${machineId}`}
                checked={showBaseline}
                onCheckedChange={(checked) => setShowBaseline(checked === true)}
              />
              <Label htmlFor={`show-baseline-${machineId}`} className="text-sm font-normal">
                Show image packages and dependencies ({baselineCount})
              </Label>
            </div>
          ) : (
            <div />
          )}
          <div>{actions}</div>
        </div>
      )}

      {/* min-h-0 and no flex-1: shrinks when content overflows, collapses to
          content otherwise. Same wrapper the Access page's tables use. */}
      <div className="min-h-0 overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]">
        <Table containerClassName="h-full max-h-[60vh]">
          <TableHeader>
            <TableRow>
              <Th icon={Package}>Package</Th>
              <Th icon={ShieldCheck}>Permission</Th>
              <Th icon={Box}>Status</Th>
              <Th icon={CircleSlash}>From</Th>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {packagesQuery.isPending && (
              <SkeletonRows widths={["w-32", "w-20", "w-28", "w-24", "w-16", "w-20"]} />
            )}
            {packagesQuery.isError && (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-destructive">
                  Failed to load packages.
                </TableCell>
              </TableRow>
            )}
            {!packagesQuery.isPending && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-muted-foreground">
                  {baselineCount > 0
                    ? "Nothing declared or added beyond the image this machine was built from."
                    : "No packages."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <PackageRow
                key={row.packageName}
                row={row}
                busy={
                  (actionMutation.isPending &&
                    actionMutation.variables?.packageName === row.packageName) ||
                  (permissionMutation.isPending &&
                    permissionMutation.variables?.row.packageName === row.packageName)
                }
                canEditPermission={canEditPermission}
                canRequestActions={canRequestActions}
                onAction={(op) => actionMutation.mutate({ packageName: row.packageName, op })}
                onPermission={(target) => permissionMutation.mutate({ row, target })}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
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

function SkeletonRows({ rows = 3, widths }: { rows?: number; widths: string[] }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton rows, never reordered.
        <TableRow key={i}>
          {widths.map((width, j) => (
            <TableCell key={width} className={j === widths.length - 1 ? "text-right" : undefined}>
              <Skeleton className={`h-4 ${width}`} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/** One column for both facts: not declared (null), excluded, or allowed with its setting. */
type PermissionValue = "excluded" | PackageSetting;

const PERMISSION_LABELS: Record<PermissionValue, string> = {
  excluded: "Excluded",
  ...PACKAGE_SETTING_LABELS,
};

const permissionOf = (row: MachinePackageRow): PermissionValue | null =>
  row.permission === "disallowed"
    ? "excluded"
    : row.permission === "allowed"
      ? (row.setting ?? "allowed")
      : null;

/**
 * The one manifest edit a Permission change makes. Excluding also resets the
 * setting, so lifting the exclusion later can never bring back an Ensure
 * setting without a fresh approval.
 */
function permissionEdit(row: MachinePackageRow, target: PermissionValue) {
  if (target === "excluded") {
    return { packageName: row.packageName, excluded: true, setting: "allowed" as const };
  }
  return {
    packageName: row.packageName,
    // Lifting an exclusion, or declaring an undeclared package, is part of the same edit.
    ...(row.permission !== "allowed" ? { excluded: false } : {}),
    // A first machine row for an inherited entry would otherwise declare
    // "any version" and quietly drop the org's version.
    ...(target !== "allowed" || row.permission === "allowed" ? { setting: target } : {}),
    ...(row.source !== null && row.source !== "machine" && row.versionPin
      ? { versionPin: row.versionPin }
      : {}),
  };
}

function PermissionCell({
  row,
  busy,
  canEdit,
  onPermission,
}: {
  row: MachinePackageRow;
  busy: boolean;
  canEdit: boolean;
  onPermission: (target: PermissionValue) => void;
}) {
  if (row.isBaseline && row.permission === null) {
    return <span className="text-sm text-muted-foreground">from the image</span>;
  }
  if (row.installedAsDependency && row.permission === null) {
    return <span className="text-sm text-muted-foreground">dependency</span>;
  }
  const value = permissionOf(row);
  if (!canEdit) {
    if (value === "excluded") return <Badge variant="outline">Excluded</Badge>;
    // A dash for undeclared: nobody has said anything at all, which is not the same as excluded.
    return (
      <span
        className={
          value === null || value === "allowed" ? "text-sm text-muted-foreground" : "text-sm"
        }
      >
        {value === null ? "—" : PERMISSION_LABELS[value]}
      </span>
    );
  }
  return (
    <Select
      {...(value !== null ? { value } : {})}
      onValueChange={(next) => {
        if (next !== value) onPermission(next as PermissionValue);
      }}
      disabled={busy}
    >
      <SelectTrigger className="h-8 w-48 text-xs" aria-label="Permission">
        <SelectValue placeholder="Not declared" />
      </SelectTrigger>
      <SelectContent>
        {(["excluded", ...PACKAGE_SETTINGS] as const).map((option) => {
          const reason =
            option === value || option === "excluded"
              ? null
              : settingUnavailableReason(option, row);
          return (
            <SelectItem key={option} value={option} disabled={reason !== null}>
              {PERMISSION_LABELS[option]}
              {reason && <span className="ml-1.5 text-xs text-muted-foreground">({reason})</span>}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** Whether Cloudable queued this action for an ensure setting, rather than a person asking. */
const isEnsureTriggered = (row: MachinePackageRow): boolean =>
  row.pendingAction?.trigger === "ensure_installed" ||
  row.pendingAction?.trigger === "ensure_latest";

function StatusCell({ row }: { row: MachinePackageRow }) {
  const pending = row.pendingAction;
  if (pending && (pending.status === "pending" || pending.status === "running")) {
    if (isEnsureTriggered(row)) {
      // An install on a package that is already there is an update to a newer version.
      return (
        <span className="text-sm text-muted-foreground">
          {row.installed === "installed"
            ? `updating${row.availableVersion ? ` to ${row.availableVersion}` : ""} (Ensure)…`
            : "installing (Ensure)…"}
        </span>
      );
    }
    return (
      <span className="text-sm text-muted-foreground">
        {pending.op === "install" ? "installing…" : "removing…"}
      </span>
    );
  }
  if (row.ensureFailure) {
    return (
      <span className="flex items-center gap-1.5 text-sm">
        <Badge variant="destructive">failed</Badge>
        <span className="text-muted-foreground">
          Install failed: {row.ensureFailure.reason}. Next try{" "}
          {formatNextTry(row.ensureFailure.nextAttemptAt)}.
        </span>
      </span>
    );
  }
  if (pending?.status === "expired") {
    return (
      <span className="flex items-center gap-1.5 text-sm">
        <Badge variant="outline">no reply</Badge>
        <span className="text-muted-foreground">the agent never reported back</span>
      </span>
    );
  }
  if (pending?.status === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-sm">
        <Badge variant="destructive">failed</Badge>
        <span className="text-muted-foreground">{pending.failureReason}</span>
      </span>
    );
  }

  if (row.installed === "unknown") {
    // Not "not installed" — the machine has told us nothing.
    return <span className="text-sm text-muted-foreground">unknown</span>;
  }
  if (row.installed === "not_installed") {
    return <span className="text-sm text-muted-foreground">not installed</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-sm">
      installed
      {row.installedVersion && (
        <span className="font-mono text-xs text-muted-foreground">{row.installedVersion}</span>
      )}
      {row.versionMismatch && (
        // Asking for a pin and getting something else is not a clean install,
        // so it does not get to look like one.
        <Badge variant="destructive" title={`Pinned to ${row.versionPin}`}>
          not the pinned version
        </Badge>
      )}
      {row.setting === "ensure_latest" &&
        row.availableVersion &&
        row.availableVersion !== row.installedVersion && (
          // Cloudable queues the update on the machine's next check-in.
          <span className="text-xs text-muted-foreground">
            update to <span className="font-mono">{row.availableVersion}</span> available
          </span>
        )}
    </span>
  );
}

function PackageRow({
  row,
  busy,
  canEditPermission,
  canRequestActions,
  onAction,
  onPermission,
}: {
  row: MachinePackageRow;
  busy: boolean;
  canEditPermission: boolean;
  canRequestActions: boolean;
  onAction: (op: PackageActionOp) => void;
  onPermission: (target: PermissionValue) => void;
}) {
  const outstanding =
    row.pendingAction?.status === "pending" || row.pendingAction?.status === "running";
  const isInstalled = row.installed === "installed";
  // Cloudable would put an ensured package straight back, so removing it is not offered.
  const isEnsured = row.setting === "ensure_installed" || row.setting === "ensure_latest";

  return (
    <TableRow className={row.isBaseline ? "opacity-70" : undefined}>
      <TableCell className={row.partOf ? "pl-8 font-medium" : "font-medium"}>
        {row.partOf && <span className="mr-1 text-muted-foreground">↳</span>}
        {row.packageName}
        {row.partOf && (
          <span className="ml-2 text-xs text-muted-foreground">part of {row.partOf}</span>
        )}
        {row.description && (
          <span className="block text-xs font-normal text-muted-foreground">{row.description}</span>
        )}
        {row.versionPin && (
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            pinned {row.versionPin}
          </span>
        )}
      </TableCell>
      <TableCell>
        <PermissionCell
          row={row}
          busy={busy}
          canEdit={canEditPermission}
          onPermission={onPermission}
        />
      </TableCell>
      <TableCell>
        <StatusCell row={row} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{row.source ?? "—"}</TableCell>
      <TableCell className="text-right">
        {/* No button at all on a base image package, rather than a disabled one
            with a tooltip: uninstalling systemd is not an option we want to
            render as merely unavailable right now. */}
        {row.isBaseline || !canRequestActions ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : row.installed === "unknown" ? (
          <span className="text-xs text-muted-foreground">waiting for the agent</span>
        ) : isInstalled && isEnsured && !outstanding ? (
          <span
            className="text-xs text-muted-foreground"
            title="Set it to Allowed to be able to remove it"
          >
            kept by Ensure
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || outstanding}
            onClick={() => onAction(isInstalled ? "uninstall" : "install")}
          >
            {outstanding ? "Working…" : isInstalled ? "Uninstall" : "Install"}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Puts each declared part directly under its parent, keeping the server's
 * order otherwise. A part whose parent is not in the list stays where it was.
 */
export function nestParts(rows: ReadonlyArray<MachinePackageRow>): MachinePackageRow[] {
  const present = new Set(rows.map((row) => row.packageName));
  const partsByParent = new Map<string, MachinePackageRow[]>();
  for (const row of rows) {
    if (row.partOf && present.has(row.partOf)) {
      partsByParent.set(row.partOf, [...(partsByParent.get(row.partOf) ?? []), row]);
    }
  }
  const placed = new Set<string>();
  const out: MachinePackageRow[] = [];
  const place = (row: MachinePackageRow) => {
    if (placed.has(row.packageName)) return;
    placed.add(row.packageName);
    out.push(row);
    for (const part of partsByParent.get(row.packageName) ?? []) place(part);
  };
  for (const row of rows) {
    if (row.partOf && present.has(row.partOf)) continue;
    place(row);
  }
  // Anything left is in a cycle of parts; show it rather than lose it.
  for (const row of rows) place(row);
  return out;
}
