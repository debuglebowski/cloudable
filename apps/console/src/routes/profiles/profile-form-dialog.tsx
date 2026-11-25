import type { MachineProvider, ProfileSummary } from "@cloudable/contracts";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";

import { profileErrorMessage } from "@/api/profiles";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";

/** What the dialog saves. Null clears a field. */
export interface ProfileFormValues {
  name: string;
  description: string | null;
  provider: MachineProvider | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
  providerLocked: boolean;
  regionLocked: boolean;
  sizeLocked: boolean;
  imageLocked: boolean;
}

const ANY = "any";
const PROVIDERS: MachineProvider[] = ["azure", "docker", "fake"];

type Locks = Pick<
  ProfileFormValues,
  "providerLocked" | "regionLocked" | "sizeLocked" | "imageLocked"
>;
const NO_LOCKS: Locks = {
  providerLocked: false,
  regionLocked: false,
  sizeLocked: false,
  imageLocked: false,
};

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

/**
 * Creates a profile, or edits one. Provider, region, size and image are optional: what the
 * profile leaves blank, the Add machine form asks for. Each set field is a starting value the
 * person can change, unless it is locked. A locked field is the same on every machine on the
 * profile, so the server refuses to lock one a machine on it does not have.
 */
export function ProfileFormDialog({
  open,
  onOpenChange,
  profile,
  save,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent creates a new profile. */
  profile?: ProfileSummary;
  save: (values: ProfileFormValues) => Promise<unknown>;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<string>(ANY);
  const [region, setRegion] = useState("");
  const [sizeSku, setSizeSku] = useState("");
  const [image, setImage] = useState("");
  const [locks, setLocks] = useState<Locks>(NO_LOCKS);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? "");
    setDescription(profile?.description ?? "");
    setProvider(profile?.provider ?? ANY);
    setRegion(profile?.region ?? "");
    setSizeSku(profile?.sizeSku ?? "");
    setImage(profile?.image ?? "");
    setLocks(
      profile
        ? {
            providerLocked: profile.providerLocked,
            regionLocked: profile.regionLocked,
            sizeLocked: profile.sizeLocked,
            imageLocked: profile.imageLocked,
          }
        : NO_LOCKS,
    );
  }, [open, profile]);

  const providerValue = provider === ANY ? null : (provider as MachineProvider);
  const regionValue = provider === "azure" ? blankToNull(region) : null;
  const sizeValue = blankToNull(sizeSku);
  const imageValue = blankToNull(image);
  const lockToggle = (flag: keyof Locks, hasValue: boolean) => (
    <Label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
      <Checkbox
        checked={hasValue && locks[flag]}
        disabled={!hasValue}
        onCheckedChange={(checked) =>
          setLocks((current) => ({ ...current, [flag]: checked === true }))
        }
      />
      Lock
    </Label>
  );

  const mutation = useMutation({
    mutationFn: () =>
      save({
        name: name.trim(),
        description: blankToNull(description),
        provider: providerValue,
        region: regionValue,
        sizeSku: sizeValue,
        image: imageValue,
        // A lock needs a value.
        providerLocked: providerValue !== null && locks.providerLocked,
        regionLocked: regionValue !== null && locks.regionLocked,
        sizeLocked: sizeValue !== null && locks.sizeLocked,
        imageLocked: imageValue !== null && locks.imageLocked,
      }),
    onSuccess: () => {
      onSaved();
      onOpenChange(false);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() !== "" && !mutation.isPending) mutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{profile ? `Edit "${profile.name}"` : "New profile"}</DialogTitle>
          <DialogDescription>
            Machines on a profile take its settings and packages, unless they override them.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Data team"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="profile-description">Description</Label>
            <Textarea
              id="profile-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Who it is for"
            />
          </div>

          <div className="mt-2 flex flex-col gap-1">
            <span className="text-sm font-medium">New machines</span>
            <span className="text-xs text-muted-foreground">
              Optional. A value here fills in the Add machine form, and the person can change it.
              Lock it to make it the same on every machine on this profile. A machine never changes
              when you edit these.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-provider">Provider</Label>
                {lockToggle("providerLocked", providerValue !== null)}
              </div>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger id="profile-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Not set</SelectItem>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-region">Region</Label>
                {lockToggle("regionLocked", regionValue !== null)}
              </div>
              <Input
                id="profile-region"
                value={region}
                disabled={provider !== "azure"}
                onChange={(event) => setRegion(event.target.value)}
                placeholder={provider === "azure" ? "e.g. swedencentral" : "Azure only"}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-size">Size</Label>
                {lockToggle("sizeLocked", sizeValue !== null)}
              </div>
              <Input
                id="profile-size"
                value={sizeSku}
                disabled={provider === ANY}
                onChange={(event) => setSizeSku(event.target.value)}
                placeholder="e.g. Standard_D4s_v5"
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-image">Image</Label>
                {lockToggle("imageLocked", imageValue !== null)}
              </div>
              <Input
                id="profile-image"
                value={image}
                disabled={provider === ANY}
                onChange={(event) => setImage(event.target.value)}
                placeholder="e.g. ubuntu-24.04"
              />
            </div>
          </div>

          {mutation.isError && (
            <p className="text-sm text-destructive">{profileErrorMessage(mutation.error)}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim() === "" || mutation.isPending}>
              {mutation.isPending ? "Saving…" : profile ? "Save" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
