import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";

import {
  type ArchivedSnapshot,
  RESTORE_MODE_APPROVAL,
  type RestoreMode,
  useRestoreSnapshot,
} from "@/api/archive";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

interface RestoreModeOption {
  mode: RestoreMode;
  label: string;
  description: string;
  badgeVariant: BadgeProps["variant"];
  icon: typeof ShieldOff;
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
// hardest to reach). See spec §14 "Restore modes — escalating approval". Approval level itself
// comes from RESTORE_MODE_APPROVAL in api/archive.ts, the single source of truth for that mapping.
const RESTORE_MODE_OPTIONS: RestoreModeOption[] = [
  {
    mode: "data",
    label: "Data only",
    description: "Reattach volume data to a new machine. Configuration is left untouched.",
    badgeVariant: approvalBadgeVariantFor("data"),
    icon: ShieldOff,
  },
  {
    mode: "config",
    label: "Config only",
    description: "Restore machine desired state and configuration. Volume data is not restored.",
    badgeVariant: approvalBadgeVariantFor("config"),
    icon: ShieldCheck,
  },
  {
    mode: "full",
    label: "Full, including secret bindings",
    description:
      "Restores data, configuration, and secret bindings. Never happens silently — this is deliberately the hardest mode to reach.",
    badgeVariant: approvalBadgeVariantFor("full"),
    icon: ShieldAlert,
  },
];

export interface RestoreDialogProps {
  snapshot: ArchivedSnapshot;
}

/** Restore-mode picker with visibly escalating friction, per spec §14. */
export function RestoreDialog({ snapshot }: RestoreDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RestoreMode>("data");
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const restore = useRestoreSnapshot();

  // Every restore is backed by an approval object regardless of mode (spec §13:
  // reason is "required free text, never optional") — the real endpoint rejects
  // an empty reason even for data-only restores, unlike the mock this replaced.
  // "Requested by" is the signed-in session, not a picker (server derives it).
  const requiresAck = mode === "full";
  const canProceed = reason.trim().length > 0 && (!requiresAck || acknowledged);

  function reset() {
    setMode("data");
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
    restore.mutate(
      { snapshotId: snapshot.id, mode, reason: reason.trim() },
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
            Snapshot from {new Date(snapshot.archivedAt).toLocaleDateString()} · {snapshot.region}.
            Every restore writes an event, whichever mode is chosen.
          </DialogDescription>
        </DialogHeader>

        {!confirmingFull && (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Restore mode">
            {RESTORE_MODE_OPTIONS.map((option) => {
              const selected = option.mode === mode;
              const Icon = option.icon;
              return (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => selectMode(option.mode)}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                    selected ? "border-primary bg-accent" : "border-border hover:bg-muted/50",
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
                </button>
              );
            })}
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
          <label className="flex items-start gap-2 rounded-md border border-drift bg-drift-soft p-3 text-sm text-drift">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I understand this reattaches secret bindings to the restored machine. Secret bindings
              are never reattached silently.
            </span>
          </label>
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
