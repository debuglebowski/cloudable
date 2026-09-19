import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { useId, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  type ArchivedSnapshot,
  RESTORE_MODE_APPROVAL,
  type RestoreMode,
  type RestoreTarget,
  useRestoreSnapshot,
} from "@/api/archive";
import { listMachines, machinesKeys } from "@/api/machines";
import { listPeople, peopleKeys } from "@/api/people";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ARCHIVED_MACHINE_STATES } from "@/routes/machines/machine-state";

interface RestoreModeOption {
  mode: RestoreMode;
  label: string;
  description: string;
  badgeVariant: BadgeProps["variant"];
  icon: typeof ShieldOff;
  /** Set when the mode cannot run at all. Greyed out WITH the reason shown, never hidden —
   * the same posture `sub-state.ts` takes for an unrestorable snapshot. */
  unavailable?: string;
}

const APPROVAL_BADGE_VARIANT: Record<
  (typeof RESTORE_MODE_APPROVAL)[RestoreMode],
  BadgeProps["variant"]
> = {
  none: "ok",
  single: "drift",
  dual: "destructive",
};

const APPROVAL_LABEL: Record<(typeof RESTORE_MODE_APPROVAL)[RestoreMode], string> = {
  none: "No approval required",
  single: "Approval required · single",
  dual: "Approval required · dual",
};

function approvalLabelFor(mode: RestoreMode): string {
  return APPROVAL_LABEL[RESTORE_MODE_APPROVAL[mode]];
}

function approvalBadgeVariantFor(mode: RestoreMode): BadgeProps["variant"] {
  return APPROVAL_BADGE_VARIANT[RESTORE_MODE_APPROVAL[mode]];
}

// Escalating order — data (default, no approval) < config (single) < full (dual, deliberately
// hardest to reach). Approval level itself comes from RESTORE_MODE_APPROVAL in api/archive.ts,
// the single source of truth for that mapping.
const RESTORE_MODE_OPTIONS: RestoreModeOption[] = [
  {
    mode: "data",
    label: "Data only",
    description: "Put the snapshot's /home back. The OS is always rebuilt fresh from the image.",
    badgeVariant: approvalBadgeVariantFor("data"),
    icon: ShieldOff,
  },
  {
    mode: "config",
    label: "Config only",
    description: "Restore machine desired state and configuration. Volume data is not restored.",
    badgeVariant: approvalBadgeVariantFor("config"),
    icon: ShieldCheck,
    unavailable: "Snapshots do not capture configuration, so there is nothing to restore from.",
  },
  {
    mode: "full",
    label: "Full, including secret bindings",
    description:
      "Restores data, configuration, and secret bindings. Never happens silently — this is deliberately the hardest mode to reach.",
    badgeVariant: approvalBadgeVariantFor("full"),
    icon: ShieldAlert,
    unavailable:
      "Secret bindings are not implemented, so a full restore has nothing extra to reattach.",
  },
];

type TargetKind = "new_machine" | "existing_machine";

export interface RestoreDialogProps {
  snapshot: ArchivedSnapshot;
}

/** Restore-mode picker with visibly escalating friction. */
export function RestoreDialog({ snapshot }: RestoreDialogProps) {
  const ackId = useId();
  const destroyAckId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RestoreMode>("data");
  const [targetKind, setTargetKind] = useState<TargetKind>("new_machine");
  const [ownerPersonId, setOwnerPersonId] = useState("");
  const [newMachineName, setNewMachineName] = useState("");
  const [confirmDestroys, setConfirmDestroys] = useState(false);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const restore = useRestoreSnapshot();

  // Only fetched while the dialog is open — an owner picker nobody has opened should not
  // cost a request on every row of the Archive page.
  const peopleQuery = useQuery({
    queryKey: peopleKeys.list(),
    queryFn: listPeople,
    enabled: open,
  });
  const machinesQuery = useQuery({
    queryKey: machinesKeys.list(),
    queryFn: listMachines,
    enabled: open,
  });

  const targetMachine = machinesQuery.data?.find((m) => m.id === snapshot.machineId);
  // Unknown counts as live. Overwriting something we cannot see the state of is the case
  // that deserves the extra confirmation, not the one that skips it.
  const targetIsLive = targetMachine ? !ARCHIVED_MACHINE_STATES.has(targetMachine.state) : true;
  const activePeople = (peopleQuery.data ?? []).filter((person) => person.active);

  // Every restore is backed by an approval object regardless of mode (reason is
  // required free text, never optional) — the real endpoint rejects an empty
  // reason even for data-only restores, unlike the mock this replaced.
  // "Requested by" is the signed-in session, not a picker (server derives it).
  const requiresAck = mode === "full";
  const modeUnavailable = RESTORE_MODE_OPTIONS.find((o) => o.mode === mode)?.unavailable;
  // Overwriting a machine that still has a data disk destroys what is on it, so the
  // acknowledgement is required — exactly as the server requires it. An archived machine
  // has nothing left to lose and needs none.
  const needsDestroyAck = targetKind === "existing_machine" && targetIsLive;
  const canProceed =
    reason.trim().length > 0 &&
    !modeUnavailable &&
    (!requiresAck || acknowledged) &&
    (!needsDestroyAck || confirmDestroys) &&
    (targetKind !== "new_machine" || ownerPersonId.length > 0);

  function reset() {
    setMode("data");
    setTargetKind("new_machine");
    setOwnerPersonId("");
    setNewMachineName("");
    setConfirmDestroys(false);
    setReason("");
    setAcknowledged(false);
    setConfirmingFull(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function selectMode(next: RestoreMode) {
    setMode(next);
    setConfirmingFull(false);
  }

  function handlePrimaryAction() {
    if (mode === "full" && !confirmingFull) {
      setConfirmingFull(true);
      return;
    }
    const target: RestoreTarget =
      targetKind === "new_machine"
        ? {
            kind: "new_machine",
            ownerPersonId,
            ...(newMachineName.trim() ? { name: newMachineName.trim() } : {}),
          }
        : {
            kind: "existing_machine",
            machineId: snapshot.machineId,
            ...(needsDestroyAck ? { confirmDestroysData: true } : {}),
          };
    restore.mutate(
      { snapshotId: snapshot.id, mode, target, reason: reason.trim() },
      { onSuccess: () => handleOpenChange(false) },
    );
  }

  const primaryLabel =
    mode === "full"
      ? confirmingFull
        ? restore.isPending
          ? "Restoring…"
          : "Confirm full restore"
        : "Review full restore"
      : restore.isPending
        ? "Restoring…"
        : `Restore (${RESTORE_MODE_OPTIONS.find((o) => o.mode === mode)?.label})`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">Restore</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore {snapshot.machineName}</DialogTitle>
          <DialogDescription>
            Snapshot from {new Date(snapshot.createdAt).toLocaleDateString()} ·{" "}
            {snapshot.region ?? "no region"}. Every restore writes an event, whichever mode is
            chosen.
          </DialogDescription>
        </DialogHeader>

        {!confirmingFull && (
          <RadioGroupPrimitive.Root
            className="flex flex-col gap-2"
            aria-label="Restore target"
            value={targetKind}
            onValueChange={(value) => setTargetKind(value as TargetKind)}
          >
            <RadioGroupPrimitive.Item
              value="new_machine"
              className={cn(
                "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                "border-border hover:bg-muted/50",
                "data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:hover:bg-accent",
              )}
            >
              <span className="text-sm font-medium">Into a new machine</span>
              <p className="text-xs text-muted-foreground">
                Provisions a machine with this snapshot's /home. Nothing existing is touched.
              </p>
            </RadioGroupPrimitive.Item>
            <RadioGroupPrimitive.Item
              value="existing_machine"
              className={cn(
                "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                "border-border hover:bg-muted/50",
                "data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:hover:bg-accent",
              )}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-medium">
                Onto {snapshot.machineName}
                {targetIsLive && <Badge variant="destructive">Destroys current data</Badge>}
              </span>
              <p className="text-xs text-muted-foreground">
                {targetIsLive
                  ? "This machine is still running. Its current /home is destroyed and replaced."
                  : "This machine is archived — its disks are already gone, so nothing is lost."}
              </p>
            </RadioGroupPrimitive.Item>
          </RadioGroupPrimitive.Root>
        )}

        {!confirmingFull && targetKind === "new_machine" && (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restore-owner">
                Owner <Badge variant="outline">required</Badge>
              </Label>
              <Select value={ownerPersonId} onValueChange={setOwnerPersonId}>
                <SelectTrigger id="restore-owner">
                  <SelectValue
                    placeholder={peopleQuery.isLoading ? "Loading people…" : "Select a person"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {activePeople.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Never inherited from the archived machine — restoring an offboarded person's data is
                exactly when the old owner is the wrong answer.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restore-new-name">Name</Label>
              <Input
                id="restore-new-name"
                value={newMachineName}
                onChange={(e) => setNewMachineName(e.target.value)}
                placeholder="Leave blank to auto-generate"
              />
            </div>
          </div>
        )}

        {!confirmingFull && (
          <RadioGroupPrimitive.Root
            className="flex flex-col gap-2"
            aria-label="Restore mode"
            value={mode}
            onValueChange={(value) => selectMode(value as RestoreMode)}
          >
            {RESTORE_MODE_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <RadioGroupPrimitive.Item
                  key={option.mode}
                  value={option.mode}
                  disabled={option.unavailable !== undefined}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                    "border-border hover:bg-muted/50",
                    "data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:hover:bg-accent",
                    "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="size-4" />
                      {option.label}
                    </span>
                    <Badge variant={option.badgeVariant}>{approvalLabelFor(option.mode)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                  {option.unavailable && (
                    <p className="text-xs font-medium text-muted-foreground">
                      Unavailable — {option.unavailable}
                    </p>
                  )}
                </RadioGroupPrimitive.Item>
              );
            })}
          </RadioGroupPrimitive.Root>
        )}

        {!confirmingFull && needsDestroyAck && (
          <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/5 p-3 text-sm">
            <Checkbox
              id={destroyAckId}
              className="mt-0.5"
              checked={confirmDestroys}
              onCheckedChange={(checked) => setConfirmDestroys(checked === true)}
            />
            <Label htmlFor={destroyAckId} className="font-normal text-destructive">
              I understand this destroys {snapshot.machineName}'s current /home and replaces it with
              this snapshot's. This requires dual approval.
            </Label>
          </div>
        )}

        {!confirmingFull && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="restore-reason">
              Reason <Badge variant="outline">required</Badge>
            </Label>
            <Input
              id="restore-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this restore needed?"
            />
          </div>
        )}

        {!confirmingFull && requiresAck && (
          <div className="flex items-start gap-2 rounded-md border border-drift bg-drift-soft p-3 text-sm text-drift">
            <Checkbox
              id={ackId}
              className="mt-0.5"
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            <Label htmlFor={ackId} className="font-normal text-drift">
              I understand this reattaches secret bindings to the restored machine. Secret bindings
              are never reattached silently.
            </Label>
          </div>
        )}

        {confirmingFull && (
          <div className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">Final confirmation — full restore</p>
            <p className="text-muted-foreground">
              Restoring <strong>{snapshot.machineName}</strong> with data, configuration, and secret
              bindings. This requires dual approval and cannot be undone silently.
            </p>
            <p className="text-xs text-muted-foreground">Reason on file: "{reason.trim()}"</p>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => (confirmingFull ? setConfirmingFull(false) : handleOpenChange(false))}
          >
            {confirmingFull ? "Back" : "Cancel"}
          </Button>
          <Button
            variant={mode === "full" ? "destructive" : "default"}
            onClick={handlePrimaryAction}
            disabled={!canProceed || restore.isPending}
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
