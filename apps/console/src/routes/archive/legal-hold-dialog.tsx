import { Lock, LockOpen } from "lucide-react";
import { useState } from "react";

import { type ArchivedSnapshot, useSetLegalHold } from "@/api/archive";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface LegalHoldDialogProps {
  snapshot: ArchivedSnapshot;
}

/**
 * Legal-hold toggle for a single snapshot. Both placing and clearing a hold require a reason
 * string — `snapshot.legal_hold_set` and `snapshot.legal_hold_cleared` both carry one, and it's
 * the audit trail for why a snapshot was, or stopped being, exempt from retention expiry.
 */
export function LegalHoldDialog({ snapshot }: LegalHoldDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const setLegalHold = useSetLegalHold();

  const nextValue = !snapshot.legalHold;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setReason("");
    }
  }

  function handleConfirm() {
    setLegalHold.mutate(
      { snapshotId: snapshot.id, legalHold: nextValue, reason: reason.trim() },
      { onSuccess: () => handleOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {snapshot.legalHold ? <Lock /> : <LockOpen />}
          {snapshot.legalHold ? "On hold" : "Place hold"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{snapshot.legalHold ? "Clear legal hold" : "Place legal hold"}</DialogTitle>
          <DialogDescription>
            {snapshot.legalHold ? (
              <>
                Clearing the hold on <strong>{snapshot.machineName}</strong> resumes its retention
                clock — the snapshot will expire on schedule again.
              </>
            ) : (
              <>
                A legal hold exempts <strong>{snapshot.machineName}</strong>'s snapshot from
                retention expiry entirely, and renders as a documented exception, not an error.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {snapshot.legalHold && snapshot.legalHoldReason && (
          <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/50 p-3 text-xs">
            <span className="font-medium text-muted-foreground">Current hold reason</span>
            <span>{snapshot.legalHoldReason}</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="legal-hold-reason">
            Reason <Badge variant="outline">required</Badge>
          </Label>
          <Input
            id="legal-hold-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              snapshot.legalHold ? "Why is the hold being lifted?" : "Why is this snapshot held?"
            }
          />
          <p className="text-xs text-muted-foreground">
            Free text, never optional — this is what shows up in the audit trail.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={reason.trim().length === 0 || setLegalHold.isPending}
          >
            {setLegalHold.isPending ? "Saving…" : snapshot.legalHold ? "Clear hold" : "Place hold"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
