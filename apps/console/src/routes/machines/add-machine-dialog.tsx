import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { createMachine, machinesKeys } from "@/api/machines";
import { useOrgSettings } from "@/api/organisation";
import { listPeople } from "@/api/people";
import { LineageGutter } from "@/components/lineage-gutter";
import { SettingRow } from "@/components/setting-row";
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

export interface AddMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULTS = { sizeSku: "Standard_D2s_v5", image: "ubuntu-24.04" };

/**
 * Real `POST /api/v1/machines`. Region is deliberately NOT a form field here:
 * spec.md §5 rejects "a wizard prefill that copies a value and forgets its
 * origin" by name (docs/inheritance.md — "No wizard prefill"). What used to be
 * a hardcoded `region: "eastus"` client default is now the org's live-resolved
 * default, shown read-only via `SettingRow`/`LineageGutter` below — the create
 * request omits `region` entirely and lets `MachineService.create` resolve it
 * server-side (`region-policy.ts`), so a later change to the org default is
 * still correct for every machine created after it, not just ones created
 * before this dialog was opened.
 *
 * No scope-2 template picker (templates don't exist in v1), no manifest editor
 * (that's the machine detail page's job, once the machine exists). Owner is
 * required and picked from the real `people` directory — CLAUDE.md invariant
 * #3: a machine always has exactly one owner, always a person.
 */
export function AddMachineDialog({ open, onOpenChange }: AddMachineDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [sizeSku, setSizeSku] = useState(DEFAULTS.sizeSku);
  const [image, setImage] = useState(DEFAULTS.image);
  const [ownerPersonId, setOwnerPersonId] = useState("");

  const orgSettingsQuery = useOrgSettings({ enabled: open });
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

          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Region</span>
            {orgSettingsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Resolving org default…</p>
            ) : (
              <div className="rounded-md border border-border px-3 py-1.5">
                <SettingRow
                  label="Region"
                  value={orgSettingsQuery.data?.regionDefault ?? "—"}
                  source="org"
                />
                <LineageGutter source="org" viewing="machine" />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Inherited from the org default (Organisation page) — not editable here. Change the org
              default to change what new machines get.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-machine-size">Size SKU</Label>
              <Input
                id="add-machine-size"
                required
                value={sizeSku}
                onChange={(event) => setSizeSku(event.target.value)}
              />
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
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="add-machine-owner">
              Owner <span className="text-destructive">(required)</span>
            </Label>
            <select
              id="add-machine-owner"
              className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={ownerPersonId}
              onChange={(event) => setOwnerPersonId(event.target.value)}
            >
              <option value="" disabled>
                {peopleQuery.isLoading ? "Loading people…" : "Select a person"}
              </option>
              {activePeople.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.email}
                </option>
              ))}
            </select>
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
