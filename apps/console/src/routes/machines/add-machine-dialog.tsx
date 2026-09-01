import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { createMachine, machinesKeys } from "@/api/machines";
import { listPeople } from "@/api/people-directory";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface AddMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULTS = { region: "eastus", sizeSku: "Standard_D2s_v5", image: "ubuntu-24.04" };

/**
 * Real `POST /api/v1/machines` — no scope-2 template picker (templates
 * don't exist in v1), no manifest editor (that's the machine detail
 * page's job, once the machine exists). Owner is required and picked from
 * the real `people` directory — CLAUDE.md invariant #3: a machine always
 * has exactly one owner, always a person, never omitted.
 */
export function AddMachineDialog({ open, onOpenChange }: AddMachineDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [region, setRegion] = useState(DEFAULTS.region);
  const [sizeSku, setSizeSku] = useState(DEFAULTS.sizeSku);
  const [image, setImage] = useState(DEFAULTS.image);
  const [ownerPersonId, setOwnerPersonId] = useState("");

  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeople,
    enabled: open,
  });
  const activePeople = (peopleQuery.data ?? []).filter((p) => p.active);

  const mutation = useMutation({
    mutationFn: () =>
      createMachine({
        name: name.trim(),
        region: region.trim(),
        sizeSku: sizeSku.trim(),
        image: image.trim(),
        ownerPersonId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setName("");
    setRegion(DEFAULTS.region);
    setSizeSku(DEFAULTS.sizeSku);
    setImage(DEFAULTS.image);
    setOwnerPersonId("");
    mutation.reset();
  }

  const canSubmit = name.trim().length > 0 && ownerPersonId.length > 0 && !mutation.isPending;

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
          <DialogTitle>Add machine</DialogTitle>
          <DialogDescription>
            Provisioned immediately with the owner you pick below — a machine always has exactly one
            owner, always a person.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-machine-name">Name</Label>
            <Input
              id="add-machine-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="db-prod-04"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-machine-region">Region</Label>
              <Input
                id="add-machine-region"
                required
                value={region}
                onChange={(event) => setRegion(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-machine-size">Size SKU</Label>
              <Input
                id="add-machine-size"
                required
                value={sizeSku}
                onChange={(event) => setSizeSku(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-machine-image">Image</Label>
            <Input
              id="add-machine-image"
              required
              value={image}
              onChange={(event) => setImage(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-machine-owner">
              Owner <span className="text-destructive">(required)</span>
            </Label>
            <Select value={ownerPersonId} onValueChange={setOwnerPersonId}>
              <SelectTrigger id="add-machine-owner">
                <SelectValue
                  placeholder={peopleQuery.isLoading ? "Loading people…" : "Select a person"}
                />
              </SelectTrigger>
              <SelectContent>
                {activePeople.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? "Creating…" : "Add machine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
