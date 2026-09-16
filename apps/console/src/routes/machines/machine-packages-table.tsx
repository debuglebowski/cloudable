import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, CircleSlash, type LucideIcon, Package, ShieldCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import {
  type MachinePackageRow,
  PackageActionError,
  type PackageActionOp,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
 * Base image packages are hidden behind the toggle. A real Ubuntu server image
 * is several hundred packages, and listing them by default buries the handful
 * anyone came here to look at.
 */
export function MachinePackagesTable({ machineId }: { machineId: string }) {
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
    onSuccess: (_action, vars) => {
      invalidate();
      // Deliberately not "installed": the machine has not done anything yet.
      toast.success(
        vars.op === "install"
          ? `Asked this machine to install "${vars.packageName}"`
          : `Asked this machine to remove "${vars.packageName}"`,
      );
    },
    onError: (err) => {
      toast.error("Couldn't request that", {
        description: err instanceof PackageActionError ? err.body.error.message : err.message,
      });
    },
  });

  const permissionMutation = useMutation({
    mutationFn: (vars: { packageName: string; allowed: boolean }) =>
      updateMachinePackages(machineId, {
        upserts: [{ packageName: vars.packageName, excluded: !vars.allowed }],
      }),
    onSuccess: (_rows, vars) => {
      invalidate();
      toast.success(
        vars.allowed
          ? `"${vars.packageName}" is allowed on this machine`
          : `"${vars.packageName}" is no longer allowed on this machine`,
      );
    },
    onError: (err) => {
      toast.error("Couldn't change that", { description: err.message });
    },
  });

  const allRows = packagesQuery.data?.items ?? [];
  const rows = showBaseline ? allRows : allRows.filter((row) => !row.isBaseline);
  const baselineCount = allRows.length - allRows.filter((row) => !row.isBaseline).length;
  const neverReported = packagesQuery.data?.lastReportedAt === null;

  return (
    <div className="flex flex-col gap-3">
      {neverReported && !packagesQuery.isPending && (
        <p className="text-sm text-muted-foreground">
          This machine hasn't reported yet, so what's installed is unknown rather than nothing.
        </p>
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
              <SkeletonRows widths={["w-32", "w-20", "w-24", "w-16", "w-20"]} />
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
                    permissionMutation.variables?.packageName === row.packageName)
                }
                onAction={(op) => actionMutation.mutate({ packageName: row.packageName, op })}
                onPermission={(allowed) =>
                  permissionMutation.mutate({ packageName: row.packageName, allowed })
                }
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {baselineCount > 0 && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`show-baseline-${machineId}`}
            checked={showBaseline}
            onCheckedChange={(checked) => setShowBaseline(checked === true)}
          />
          <Label htmlFor={`show-baseline-${machineId}`} className="text-sm font-normal">
            Show base image packages ({baselineCount})
          </Label>
        </div>
      )}
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

function PermissionCell({
  row,
  busy,
  onPermission,
}: {
  row: MachinePackageRow;
  busy: boolean;
  onPermission: (allowed: boolean) => void;
}) {
  if (row.isBaseline && row.permission === null) {
    return <span className="text-sm text-muted-foreground">from the image</span>;
  }
  if (row.permission === "allowed") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onPermission(false)}
        className="text-sm underline-offset-4 hover:underline disabled:opacity-50"
        title="Stop allowing this package on this machine"
      >
        allowed
      </button>
    );
  }
  if (row.permission === "disallowed") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onPermission(true)}
        className="text-sm underline-offset-4 hover:underline disabled:opacity-50"
        title="Allow this package on this machine"
      >
        <Badge variant="outline">disallowed</Badge>
      </button>
    );
  }
  // Installed and nobody said it could be. The dash is the honest rendering —
  // it is not disallowed, nobody has said anything at all.
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPermission(true)}
      className="text-sm text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
      title="Allow this package on this machine"
    >
      —
    </button>
  );
}

function StatusCell({ row }: { row: MachinePackageRow }) {
  const pending = row.pendingAction;
  if (pending && (pending.status === "pending" || pending.status === "running")) {
    return (
      <span className="text-sm text-muted-foreground">
        {pending.op === "install" ? "installing…" : "removing…"}
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
    </span>
  );
}

function PackageRow({
  row,
  busy,
  onAction,
  onPermission,
}: {
  row: MachinePackageRow;
  busy: boolean;
  onAction: (op: PackageActionOp) => void;
  onPermission: (allowed: boolean) => void;
}) {
  const outstanding =
    row.pendingAction?.status === "pending" || row.pendingAction?.status === "running";
  const isInstalled = row.installed === "installed";

  return (
    <TableRow className={row.isBaseline ? "opacity-70" : undefined}>
      <TableCell className="font-medium">
        {row.packageName}
        {row.versionPin && (
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            pinned {row.versionPin}
          </span>
        )}
      </TableCell>
      <TableCell>
        <PermissionCell row={row} busy={busy} onPermission={onPermission} />
      </TableCell>
      <TableCell>
        <StatusCell row={row} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{row.source ?? "—"}</TableCell>
      <TableCell className="text-right">
        {/* No button at all on a base image package, rather than a disabled one
            with a tooltip: uninstalling systemd is not an option we want to
            render as merely unavailable right now. */}
        {row.isBaseline ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : row.installed === "unknown" ? (
          <span className="text-xs text-muted-foreground">waiting for the agent</span>
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
