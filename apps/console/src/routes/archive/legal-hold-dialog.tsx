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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface LegalHoldDialogProps {
  /** `null` closes the dialog — same "target row or null" convention as
   * `access/revoke-certificate-dialog.tsx`, rather than a separate `open` boolean. */
  snapshot: ArchivedSnapshot | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Legal-hold toggle for a single snapshot. Both placing and clearing a hold require a reason
 * string — `snapshot.legal_hold_set` and `snapshot.legal_hold_cleared` both carry one, and it's
 * the audit trail for why a snapshot was, or stopped being, exempt from retention expiry.
 *
 * One instance rendered per page (not per row), targeted via `snapshot` — opened from the row's
 * actions menu (`archive/page.tsx`), which is the only thing that toggles hold state; the Legal
 * hold column itself is a read-only status badge.
 */
export function LegalHoldDialog({ snapshot, onOpenChange }: LegalHoldDialogProps) {
  const [reason, setReason] = useState("");
  const setLegalHold = useSetLegalHold();

  function handleOpenChange(open: boolean) {
    onOpenChange(open);
    if (!open) {
      setReason("");
    }
  }

  function handleConfirm() {
    if (!snapshot) return;
    setLegalHold.mutate(
      { snapshotId: snapshot.id, legalHold: !snapshot.legalHold, reason: reason.trim() },
      { onSuccess: () => handleOpenChange(false) },
    );
  }

  return (
    <Dialog open={snapshot != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{snapshot?.legalHold ? "Clear legal hold" : "Place legal hold"}</DialogTitle>
          <DialogDescription>
            {snapshot &&
              (snapshot.legalHold ? (
                <>
                  Clearing the hold on <strong>{snapshot.machineName}</strong> resumes its retention
                  clock — the snapshot will expire on schedule again.
                </>
              ) : (
                <>
                  A legal hold exempts <strong>{snapshot.machineName}</strong>'s snapshot from
                  retention expiry entirely, and renders as a documented exception, not an error.
                </>
              ))}
          </DialogDescription>
        </DialogHeader>

        {snapshot?.legalHold && snapshot.legalHoldReason && (
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
              snapshot?.legalHold ? "Why is the hold being lifted?" : "Why is this snapshot held?"
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
            {setLegalHold.isPending ? "Saving…" : snapshot?.legalHold ? "Clear hold" : "Place hold"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
