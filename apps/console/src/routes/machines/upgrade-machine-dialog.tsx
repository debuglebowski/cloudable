import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { type Machine, machinesKeys, triggerUpgrade } from "@/api/machines";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface UpgradeMachineDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const OUTCOME_LABEL: Record<string, string> = {
  success: "Succeeded",
  rolled_back: "Rolled back",
  aborted: "Aborted",
  rollback_failed: "Rollback failed",
};

/** `rolled_back`/`aborted` both mean "the upgrade didn't happen, but the machine is in a
 * known-safe state" — worth flagging (`drift`), not a fault. `rollback_failed` is the one
 * outcome where the safety net itself failed: the machine can be left in a genuinely broken,
 * inconsistent state needing urgent attention, which reads as calmly as the other two under
 * one shared "non-success" color. Matches this app's own rule that severity color is a
 * compliance signal, not decoration (see Audit's/Access's severity badges). */
function outcomeVariant(outcome: string): BadgeProps["variant"] {
  if (outcome === "success") return "ok";
  if (outcome === "rollback_failed") return "destructive";
  return "drift";
}

/**
 * Real `POST /api/v1/machines/:id/upgrade` — snapshot -> apply -> verify ->
 * roll back to the pre-upgrade snapshot on verification failure. Any
 * outcome besides "success" still means the request succeeded — the
 * machine's own upgrade attempt failed and was (or wasn't) rolled back;
 * that's rendered, not thrown as an error.
 */
export function UpgradeMachineDialog({ machine, open, onOpenChange }: UpgradeMachineDialogProps) {
  const queryClient = useQueryClient();
  const [targetImage, setTargetImage] = useState("");

  const mutation = useMutation({
    mutationFn: () => triggerUpgrade(machine.id, targetImage.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.detail(machine.id) });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.drift(machine.id) });
    },
  });

  function reset() {
    setTargetImage("");
    mutation.reset();
  }

  const result = mutation.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upgrade {machine.name}</DialogTitle>
          <DialogDescription>
            Current image: <span className="font-mono">{machine.image}</span>. Snapshots first,
            applies the new image, verifies it came up clean, and rolls back to the pre-upgrade
            snapshot automatically if it didn't.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upgrade-target-image">Target image</Label>
            <Input
              id="upgrade-target-image"
              required
              value={targetImage}
              onChange={(event) => setTargetImage(event.target.value)}
              placeholder="ubuntu-24.04"
            />
          </div>
        )}

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Outcome:</span>
              <Badge variant={outcomeVariant(result.outcome)}>
                {OUTCOME_LABEL[result.outcome] ?? result.outcome}
              </Badge>
            </div>
            <p>
              {result.previousImage} → {result.currentImage}
              {result.outcome !== "success" ? ` (target was ${result.targetImage})` : ""}
            </p>
            {result.failureReason && (
              <p className="text-xs text-muted-foreground">{result.failureReason}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Next attempt eligible at {new Date(result.nextEligibleAt).toLocaleString()}.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={!targetImage.trim() || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Upgrading…" : "Upgrade"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
