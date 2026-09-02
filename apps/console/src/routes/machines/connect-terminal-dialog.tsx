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

export interface ConnectTerminalDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Always connects as "root" for now — a deliberate first-cut simplification, not a policy
 * statement: nothing server-side treats OS user as anything but a shape-validated string
 * (`tunnel/server.ts`'s `OS_USERNAME_PATTERN`), and access is gated on who's connecting
 * (owner/elevation), not which OS user they asked for. A per-machine/org default, with this
 * overridable per-connection, is the next step once that's actually needed.
 *
 * Real `POST /api/v1/access/sessions` (method: "terminal") — mints a session token, then
 * navigates to the terminal page, which attaches to it over a websocket. A
 * fresh mint every time this dialog submits: rejoining an *existing* session is a separate,
 * simpler path (the Access page's own "Connect" action on an already-open session row —
 * see `routes/access/page.tsx`), which skips this dialog entirely since there's nothing
 * left to ask.
 */
export function ConnectTerminalDialog({ machine, open, onOpenChange }: ConnectTerminalDialogProps) {
  const navigate = useNavigate();
  const mutation = useMintSession();

  function handleOpenChange(next: boolean) {
    if (!next) mutation.reset();
    onOpenChange(next);
  }

  function handleConnect() {
    mutation.mutate(
      { targetMachineId: machine.id, targetOsUser: "root" },
      {
        onSuccess: (session) => {
          handleOpenChange(false);
          void navigate({
            to: "/access/sessions/$sessionId/terminal",
            params: { sessionId: session.sessionId },
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect to {machine.name}</DialogTitle>
          <DialogDescription>
            Opens a web terminal routed through the tunnel daemon as "root" — never a public
            endpoint. The session is tied to your own signed-in identity.
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Couldn't connect."}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={mutation.isPending} onClick={handleConnect}>
            {mutation.isPending ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
