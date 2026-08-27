import { useState } from "react";

import { type ActiveSession, useTerminateSession } from "@/api/access";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TerminateSessionDialogProps {
  session: ActiveSession | null;
  onOpenChange: (open: boolean) => void;
}

/** Terminating a session is immediate and unannounced to the person in it — the warning below says so. */
export function TerminateSessionDialog({ session, onOpenChange }: TerminateSessionDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const terminateSession = useTerminateSession();

  function handleOpenChange(open: boolean) {
    if (!open) setError(null);
    onOpenChange(open);
  }

  async function handleConfirm() {
    if (!session) return;
    setError(null);
    try {
      await terminateSession.mutateAsync(session.id);
      handleOpenChange(false);
    } catch {
      setError("Couldn't terminate this session. Try again.");
    }
  }

  return (
    <Dialog open={session != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminate session</DialogTitle>
          <DialogDescription>
            {session &&
              `Ends ${session.personName}'s ${session.method} session on ${session.machineName} as ${session.osUser}.`}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md bg-drift-soft px-3 py-2 text-sm text-drift">
          This disconnects the session right away with no warning to the person in it. Any unsaved
          work in it is lost.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={terminateSession.isPending}
            onClick={handleConfirm}
          >
            Terminate session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
