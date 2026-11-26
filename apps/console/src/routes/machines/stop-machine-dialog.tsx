import { useMutation, useQueryClient } from "@tanstack/react-query";

import { type Machine, machinesKeys, setMachinePower } from "@/api/machines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface StopMachineDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * `POST /api/v1/machines/:id/stop`. Stopping saves money and loses nothing, so there is no
 * approval, only this confirmation. The stop itself runs in the background; the page shows
 * "Stopping" until it is done.
 */
export function StopMachineDialog({ machine, open, onOpenChange }: StopMachineDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => setMachinePower(machine.id, "stop"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.detail(machine.id) });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
      onOpenChange(false);
    },
  });

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
          <DialogTitle>Stop {machine.name}?</DialogTitle>
          <DialogDescription>
            Open sessions end and the machine stops costing compute. Nothing on it is lost, and you
            can start it again at any time.
          </DialogDescription>
        </DialogHeader>

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Stopping…" : "Stop"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
