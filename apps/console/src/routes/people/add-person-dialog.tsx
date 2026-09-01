import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { addPerson, peopleKeys } from "@/api/people";
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

export interface AddPersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_ROLE = "member";

/** Manual-entry flow — added people always start as `source: "manual"`, active. */
export function AddPersonDialog({ open, onOpenChange }: AddPersonDialogProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(DEFAULT_ROLE);

  const mutation = useMutation({
    mutationFn: () => addPerson({ email: email.trim(), role: role.trim() || DEFAULT_ROLE }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peopleKeys.list() });
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setEmail("");
    setRole(DEFAULT_ROLE);
    mutation.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add person</DialogTitle>
          <DialogDescription>
            Manually added people are always fully editable, independent of any SCIM connection.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) mutation.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-person-email">Email</Label>
            <Input
              id="add-person-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-person-role">Role</Label>
            <Input
              id="add-person-role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              placeholder={DEFAULT_ROLE}
            />
          </div>
          {mutation.isError && <p className="text-sm text-destructive">{mutation.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!email.trim() || mutation.isPending}>
              {mutation.isPending ? "Adding…" : "Add person"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
