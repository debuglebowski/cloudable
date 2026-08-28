import type { Person } from "@/api/people";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface DeactivatePersonDialogProps {
  person: Person | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (person: Person) => void;
}

/**
 * Deactivation has compliance implications (check "Machine has an active owner" fails once the
 * owner is deactivated), so it's a real confirmed action rather than a bare toggle. Live
 * machine-ownership data isn't wired into the console yet, so this is a client-side notice only —
 * it doesn't (and can't yet) check whether `person` actually owns any machines.
 */
export function DeactivatePersonDialog({
  person,
  onOpenChange,
  onConfirm,
}: DeactivatePersonDialogProps) {
  return (
    <Dialog open={person != null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate {person?.email}?</DialogTitle>
          <DialogDescription>
            Deactivating a person disqualifies them as a machine owner. The compliance check
            &quot;Machine has an active owner&quot; will fail for any machine still assigned to this
            person once deactivated — reassign ownership first if they currently own any live
            machines. This page doesn&apos;t have machine-ownership data wired in yet, so verify
            that separately before confirming.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (person) onConfirm(person);
            }}
          >
            Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
