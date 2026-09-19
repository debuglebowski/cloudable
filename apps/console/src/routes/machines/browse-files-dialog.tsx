import { useNavigate } from "@tanstack/react-router";

import { useMintSession } from "@/api/access";
import type { Machine } from "@/api/machines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface BrowseFilesDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mirrors `connect-terminal-dialog.tsx` exactly, with `method: "files"` — mints a session
 * token via `POST /api/v1/access/sessions`, then navigates to the file page, which attaches
 * to it over the same websocket the terminal uses.
 *
 * A files session is strictly less than a terminal one. It is gated on its own
 * `accessMethodsEnabled.files` flag, and for a machine you do not own it is satisfied by a
 * `file_recovery` elevation as well as a `shell` one — which is the point: recovering a
 * file from a colleague's machine should not require the approval floor that handing
 * yourself a shell on it does (`docs/spec.md` §15).
 *
 * Enablement is not checked here. `Connect` next to it doesn't either, and the server's own
 * `method_disabled` denial is the single authority on it — a button that predicts policy
 * from a stale cached read would sometimes be wrong in the permissive direction, which is
 * the worse way to be wrong.
 */
export function BrowseFilesDialog({ machine, open, onOpenChange }: BrowseFilesDialogProps) {
  const navigate = useNavigate();
  const mutation = useMintSession();

  function handleOpenChange(next: boolean) {
    if (!next) mutation.reset();
    onOpenChange(next);
  }

  function handleBrowse() {
    mutation.mutate(
      { targetMachineId: machine.id, method: "files" },
      {
        onSuccess: (session) => {
          handleOpenChange(false);
          void navigate({
            to: "/machines/$machineId/sessions/$sessionId/files",
            params: { machineId: machine.id, sessionId: session.sessionId },
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Browse files on {machine.name}</DialogTitle>
          <DialogDescription>
            Opens a file session routed through the tunnel daemon, never a public endpoint. Files
            are read and written as the machine's own Unix user, so you can reach exactly what a
            terminal session could and nothing more. The session is tied to your signed-in identity
            and appears on the Access page while it is open.
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Couldn't open files."}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={mutation.isPending} onClick={handleBrowse}>
            {mutation.isPending ? "Opening…" : "Browse files"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
