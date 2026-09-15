import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { type Machine, type SnapshotScope, machinesKeys, triggerUpgrade } from "@/api/machines";
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
import { cn } from "@/lib/utils";

export interface UpgradeMachineDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const OUTCOME_LABEL: Record<string, string> = {
  success: "Succeeded",
  rolled_back: "Rolled back",
  aborted: "Aborted",
  // Reached whenever apply or verify fails, because there is no restore operation on
  // any ProvisioningService yet — so "not rolled back" is the honest label, not
  // "rollback failed", which implies something was attempted and errored.
  rollback_failed: "Not rolled back",
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

/** What each snapshot scope actually costs and buys, in the person's terms rather than
 * the schema's. `/home` is on the persistent disk, so "shallow" is not a lesser backup
 * of the same thing — it is a complete copy of the only part that cannot be rebuilt. */
const SCOPE_OPTIONS: ReadonlyArray<{
  scope: SnapshotScope;
  label: string;
  description: string;
}> = [
  {
    scope: "full",
    label: "Full snapshot",
    description:
      "Copies the operating system disk as well as your files. Bigger and slower, and the only one that could put the machine back exactly as it was.",
  },
  {
    scope: "shallow",
    label: "Shallow snapshot",
    description:
      "Copies only the disk holding your files. Smaller and faster. The operating system is rebuilt from its image, which is what an upgrade does anyway.",
  },
];

/**
 * Real `POST /api/v1/machines/:id/upgrade` — snapshot -> apply -> verify. Any outcome
 * besides "success" still means the REQUEST succeeded; the machine's own upgrade
 * attempt failed, and that is rendered rather than thrown.
 *
 * Note there is no rollback step in that list. Nothing restores a snapshot yet, so a
 * failed verify leaves the machine on the new image — see `OUTCOME_LABEL`.
 */
export function UpgradeMachineDialog({ machine, open, onOpenChange }: UpgradeMachineDialogProps) {
  const queryClient = useQueryClient();
  const [targetImage, setTargetImage] = useState("");
  const [scope, setScope] = useState<SnapshotScope>("full");

  const mutation = useMutation({
    mutationFn: () => triggerUpgrade(machine.id, targetImage.trim(), scope),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.detail(machine.id) });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.drift(machine.id) });
    },
  });

  function reset() {
    setTargetImage("");
    setScope("full");
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
            applies the new image, and verifies it came up clean. There is no automatic rollback
            yet: if the new image fails to verify, the machine stays on it and is flagged for manual
            attention.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="flex flex-col gap-4">
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

            <div className="flex flex-col gap-1.5">
              <Label>Snapshot first</Label>
              <RadioGroupPrimitive.Root
                className="flex flex-col gap-2"
                aria-label="Snapshot scope"
                value={scope}
                onValueChange={(value) => setScope(value as SnapshotScope)}
              >
                {SCOPE_OPTIONS.map((option) => (
                  <RadioGroupPrimitive.Item
                    key={option.scope}
                    value={option.scope}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                      "border-border hover:bg-muted/50",
                      "data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:hover:bg-accent",
                    )}
                  >
                    <span className="text-sm font-medium">{option.label}</span>
                    <p className="text-xs text-muted-foreground">{option.description}</p>
                  </RadioGroupPrimitive.Item>
                ))}
              </RadioGroupPrimitive.Root>
            </div>
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
