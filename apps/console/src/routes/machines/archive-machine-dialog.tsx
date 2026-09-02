import { useMutation, useQueryClient } from "@tanstack/react-query";

import { archiveKeys } from "@/api/archive";
import { type Machine, archiveMachine, machinesKeys } from "@/api/machines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ArchiveMachineDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Real `POST /api/v1/archive/machines/:id/archive` — one-way `live ->
 * archived_restorable` (archived, never deleted, so this never
 * offers anything stronger than "archive"). Not on the approval-consumer
 * list (`docs/lifecycle.md`), unlike Offboard's mutation — no reason/approval
 * step here, just a confirmation.
 */
export function ArchiveMachineDialog({ machine, open, onOpenChange }: ArchiveMachineDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => archiveMachine(machine.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.detail(machine.id) });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
      // A final snapshot is created as part of archiving — the Archive page's
      // snapshot list is now stale too.
      void queryClient.invalidateQueries({ queryKey: archiveKeys.snapshots() });
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
          <DialogTitle>Archive {machine.name}?</DialogTitle>
          <DialogDescription>
            Takes a final snapshot and starts its retention clock, then terminates any live terminal
            session. This is one-way — there's no path back to a live machine — but nothing is
            deleted: the machine stays visible on this page behind "Show archived", and its data can
            still be restored from Archive until the retention window expires.
          </DialogDescription>
        </DialogHeader>

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
          </p>
        )}

        {result && (
          <p className="text-sm">
            Archived. Final snapshot <span className="font-mono">{result.snapshotId}</span> retained
            until{" "}
            <span className="font-medium">
              {new Date(result.retentionExpiresAt).toLocaleDateString()}
            </span>
            .
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Archiving…" : "Archive"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
