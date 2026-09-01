import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ConnectTerminalDialogProps {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Same conservative POSIX/Linux username shape the control plane and tunnel daemon both
 * enforce server-side (`tunnel/server.ts`'s `OS_USERNAME_PATTERN`,
 * `apps/tunnel-daemon/src/pty.ts`) — checked here only so a malformed value never even
 * reaches the mint call, not as the real security boundary (that's server-side, twice over). */
const OS_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Real `POST /api/v1/access/sessions` (method: "terminal") — mints a session token, then
 * navigates to the terminal page, which attaches to it over a websocket (spec §11.1). A
 * fresh mint every time this dialog submits: rejoining an *existing* session is a separate,
 * simpler path (the Access page's own "Connect" action on an already-open session row —
 * see `routes/access/page.tsx`), which skips this dialog entirely since there's nothing
 * left to ask.
 */
export function ConnectTerminalDialog({ machine, open, onOpenChange }: ConnectTerminalDialogProps) {
  const [targetOsUser, setTargetOsUser] = useState("");
  const navigate = useNavigate();
  const mutation = useMintSession();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTargetOsUser("");
      mutation.reset();
    }
    onOpenChange(next);
  }

  function handleConnect() {
    mutation.mutate(
      { targetMachineId: machine.id, targetOsUser: targetOsUser.trim() },
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

  const trimmed = targetOsUser.trim();
  const isValidOsUser = OS_USER_PATTERN.test(trimmed);
  const canSubmit = isValidOsUser && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect to {machine.name}</DialogTitle>
          <DialogDescription>
            Opens a web terminal routed through the tunnel daemon — never a public endpoint (spec
            §11.1). The session is tied to your own signed-in identity.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="connect-os-user">Target OS user</Label>
          <Input
            id="connect-os-user"
            value={targetOsUser}
            onChange={(event) => setTargetOsUser(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSubmit) handleConnect();
            }}
            placeholder="ubuntu"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {trimmed.length > 0 && !isValidOsUser && (
            <p className="text-xs text-destructive">
              Lowercase letters, digits, underscore, hyphen — must start with a letter or
              underscore.
            </p>
          )}
        </div>
        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Couldn't connect."}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={handleConnect}>
            {mutation.isPending ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
