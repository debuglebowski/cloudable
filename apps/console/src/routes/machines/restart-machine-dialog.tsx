import { useMutation, useQueryClient } from "@tanstack/react-query";

import { type Machine, machinesKeys, restartMachine } from "@/api/machines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface RestartMachineDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Real `POST /api/v1/machines/:id/restart` — reboots the machine's underlying
 * compute in place. Same identity and declared packages throughout; only ends
 * any live terminal/SSH session against it.
 */
export function RestartMachineDialog({ machine, open, onOpenChange }: RestartMachineDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => restartMachine(machine.id),
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
          <DialogTitle>Restart {machine.name}?</DialogTitle>
          <DialogDescription>
            Reboots the machine's underlying compute. Any active terminal or SSH session against it
            ends immediately; the machine keeps its identity and declared packages.
          </DialogDescription>
        </DialogHeader>

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
          </p>
        )}

        {result && <p className="text-sm">Machine restarted.</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? "Restarting…" : "Restart"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
