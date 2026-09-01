import { useState } from "react";

import type { OffboardPersonResult } from "@/api/offboarding";
import { useOffboardPersonMutation, useSyncOffboardingMutation } from "@/api/offboarding";
import type { Person } from "@/api/people";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface OffboardPersonDialogProps {
  person: Person | null;
  onOpenChange: (open: boolean) => void;
}

const STATUS_LABEL: Record<OffboardPersonResult["status"], string> = {
  approved: "Approved",
  pending: "Pending approval",
  rejected: "Rejected",
  expired: "Expired",
};

/**
 * Approval-gated (spec §13/§14): revokes live certificates, stops every
 * machine this person owns, clears ownership, archives each one and starts
 * its retention clock. Distinct from "Deactivate" (which only flips
 * `people.active`) — offboarding doesn't itself deactivate the person, so
 * this dialog says so rather than implying it does.
 */
export function OffboardPersonDialog({ person, onOpenChange }: OffboardPersonDialogProps) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<OffboardPersonResult | null>(null);
  const mutation = useOffboardPersonMutation();
  const syncMutation = useSyncOffboardingMutation();

  function reset() {
    setReason("");
    setResult(null);
    mutation.reset();
    syncMutation.reset();
  }

  const reasonTrimmed = reason.trim();

  return (
    <Dialog
      open={person != null}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offboard {person?.email}?</DialogTitle>
          <DialogDescription>
            Revokes every live SSH certificate, stops and archives every machine this person owns
            (starting its retention clock), and clears ownership. This does not deactivate them — do
            that separately if they should also lose People-page access.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="offboard-reason">
              Reason <span className="text-destructive">(required)</span>
            </Label>
            <Textarea
              id="offboard-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Why is this person being offboarded? This becomes part of the audit record."
            />
          </div>
        )}

        {(mutation.isError || syncMutation.isError) && (
          <p className="text-sm text-destructive">
            {(mutation.error ?? syncMutation.error) instanceof Error
              ? ((mutation.error ?? syncMutation.error) as Error).message
              : "Something went wrong."}
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Approval:</span>
              <Badge variant={result.status === "approved" ? "ok" : "outline"}>
                {STATUS_LABEL[result.status]}
              </Badge>
            </div>
            {result.status === "approved" && (
              <p>
                {result.machinesOffboarded.length} machine
                {result.machinesOffboarded.length === 1 ? "" : "s"} stopped and archived.
              </p>
            )}
            {result.status === "pending" && (
              <p className="text-muted-foreground">
                Awaiting approval — once decided, come back and check again. This does not resume on
                its own.
              </p>
            )}
            {result.machineFailures.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                <p className="font-medium text-destructive">
                  {result.machineFailures.length} machine
                  {result.machineFailures.length === 1 ? "" : "s"} failed partway through:
                </p>
                <ul className="list-inside list-disc text-xs text-destructive">
                  {result.machineFailures.map((f) => (
                    <li key={f.machineId}>
                      {f.machineId}: {f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              type="button"
              variant="destructive"
              disabled={!reasonTrimmed || mutation.isPending}
              onClick={() => {
                if (person && reasonTrimmed) {
                  mutation.mutate(
                    { personId: person.id, reason: reasonTrimmed },
                    { onSuccess: setResult },
                  );
                }
              }}
            >
              {mutation.isPending ? "Offboarding…" : "Offboard"}
            </Button>
          )}
          {result?.status === "pending" && (
            <Button
              type="button"
              variant="secondary"
              disabled={syncMutation.isPending}
              onClick={() => syncMutation.mutate(result.approvalId, { onSuccess: setResult })}
            >
              {syncMutation.isPending ? "Checking…" : "Check again"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
