import { useMutation, useQueryClient } from "@tanstack/react-query";

import { type Machine, machinesKeys, triggerReconcile } from "@/api/machines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ReconcileMachineDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Real `POST /api/v1/config/machines/:id/reconcile` — the ONLY operation
 * that mutates a live machine (spec §16). Editing desired state (package
 * manifest overrides, org/machine settings) is always inert on its own;
 * nothing takes effect on the real machine until this runs, and the agent
 * picks it up on its next ~30s poll, not instantly.
 */
export function ReconcileMachineDialog({
  machine,
  open,
  onOpenChange,
}: ReconcileMachineDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => triggerReconcile(machine.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.detail(machine.id) });
    },
  });

  const result = mutation.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconcile {machine.name}?</DialogTitle>
          <DialogDescription>
            Bumps this machine's desired-state version. The agent applies it on its next poll (~30s)
            — this doesn't happen instantly, and doesn't install anything not already declared
            (invariant #4: reconcile only closes gaps).
          </DialogDescription>
        </DialogHeader>

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
          </p>
        )}

        {result && (
          <p className="text-sm">
            Desired state is now version{" "}
            <span className="font-mono">{result.desiredStateVersion}</span>.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? "Reconciling…" : "Reconcile"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
