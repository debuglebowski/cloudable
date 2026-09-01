import { useState } from "react";

import {
  ACTION_TYPE_LABELS,
  type Approval,
  type Decision,
  useDecideApprovalMutation,
} from "@/api/approvals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// "Who is deciding" is the signed-in session, not a picker — the server
// derives it from `CurrentUserTag` and rejects the request entirely if
// there's no session, so there's nothing to select here (see
// `api/approvals.ts`'s header comment).

export interface ApprovalDecisionDialogProps {
  approval: Approval;
  decision: Decision;
}

/**
 * Grant/Deny gate for one pending approval row.
 *
 * Both decisions require a deliberate confirming click inside a dialog rather than
 * acting on the row button directly, so a stray click can't grant or deny anything.
 * Per spec §13, "a confirmation dialog is self-approval and is not an approval" — so
 * the dialog itself only guards against accidental clicks; the confirm button is what
 * actually calls `decideApproval`, which is what creates the real decision record.
 *
 * Denial additionally requires a non-empty reason: the confirm button stays disabled
 * until one is entered (client-side validation blocking submission, not just a hint).
 */
export function ApprovalDecisionDialog({ approval, decision }: ApprovalDecisionDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const mutation = useDecideApprovalMutation();

  const isDeny = decision === "rejected";
  const reasonTrimmed = reason.trim();
  const canSubmit = isDeny ? reasonTrimmed.length > 0 : true;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setReason("");
      mutation.reset();
    }
  }

  function handleConfirm() {
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate(
      {
        approvalId: approval.id,
        decision,
        ...(isDeny ? { reason: reasonTrimmed } : {}),
      },
      { onSuccess: () => handleOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant={isDeny ? "destructive" : "default"}>
          {isDeny ? "Deny" : "Grant"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDeny ? "Deny approval" : "Grant approval"}</DialogTitle>
          <DialogDescription>
            {ACTION_TYPE_LABELS[approval.actionType]} requested by {approval.requestedByName} for{" "}
            {approval.targetLabel}.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {approval.reason}
        </p>

        {isDeny && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`deny-reason-${approval.id}`}>
              Reason for denial <span className="text-destructive">(required)</span>
            </Label>
            <Textarea
              id={`deny-reason-${approval.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Why is this being denied? This becomes part of the audit record."
            />
            {reasonTrimmed.length === 0 && (
              <span className="text-xs text-muted-foreground">
                A reason is required — denials are evidence.
              </span>
            )}
          </div>
        )}

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
          </p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            variant={isDeny ? "destructive" : "default"}
            disabled={!canSubmit || mutation.isPending}
            onClick={handleConfirm}
          >
            {mutation.isPending ? "Submitting…" : isDeny ? "Confirm denial" : "Confirm grant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
