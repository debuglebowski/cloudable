import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  ACTION_TYPE_LABELS,
  type Approval,
  type Decision,
  useDecideApprovalMutation,
} from "@/api/approvals";
import { listPeople } from "@/api/people-directory";
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

// There is no auth/identity system yet (see docs/spec.md's known-gaps note),
// so "who is deciding" has to be picked from the org's real people instead
// of assumed to be "the signed-in user" — there is no such session concept
// to read it from.

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
  const [deciderId, setDeciderId] = useState("");
  const mutation = useDecideApprovalMutation();
  const peopleQuery = useQuery({ queryKey: ["people-directory"], queryFn: listPeople, enabled: open });

  const isDeny = decision === "rejected";
  const reasonTrimmed = reason.trim();
  const canSubmit = (isDeny ? reasonTrimmed.length > 0 : true) && deciderId.length > 0;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setReason("");
      setDeciderId("");
      mutation.reset();
    }
  }

  function handleConfirm() {
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate(
      {
        approvalId: approval.id,
        decision,
        decidedByPersonId: deciderId,
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

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`decider-${approval.id}`} className="text-sm font-medium">
            Deciding as <span className="text-destructive">(required)</span>
          </label>
          <select
            id={`decider-${approval.id}`}
            value={deciderId}
            onChange={(event) => setDeciderId(event.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="" disabled>
              {peopleQuery.isLoading ? "Loading people…" : "Select a person"}
            </option>
            {peopleQuery.data?.map((person) => (
              <option key={person.id} value={person.id}>
                {person.email}
              </option>
            ))}
          </select>
          {peopleQuery.isError && (
            <span className="text-xs text-destructive">Failed to load people.</span>
          )}
        </div>

        {isDeny && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`deny-reason-${approval.id}`} className="text-sm font-medium">
              Reason for denial <span className="text-destructive">(required)</span>
            </label>
            <textarea
              id={`deny-reason-${approval.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Why is this being denied? This becomes part of the audit record."
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
