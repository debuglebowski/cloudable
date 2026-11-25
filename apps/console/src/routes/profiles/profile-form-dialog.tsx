import type { MachineProvider, ProfileSummary } from "@cloudable/contracts";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";

import { profileErrorMessage } from "@/api/profiles";
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
import { Textarea } from "@/components/ui/textarea";

/** What the dialog saves. Null clears a field. */
export interface ProfileFormValues {
  name: string;
  description: string | null;
  provider: MachineProvider | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
}

const ANY = "any";
const PROVIDERS: MachineProvider[] = ["azure", "docker", "fake"];

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

/**
 * Creates a profile, or edits one. Provider, region, size and image are optional: what the
 * profile leaves blank, the Add machine form asks for. They cannot change while a machine
 * uses the profile, so the dialog shows them read-only then.
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

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? "");
    setDescription(profile?.description ?? "");
    setProvider(profile?.provider ?? ANY);
    setRegion(profile?.region ?? "");
    setSizeSku(profile?.sizeSku ?? "");
    setImage(profile?.image ?? "");
  }, [open, profile]);

  const fieldsFixed = (profile?.machineCount ?? 0) > 0;

  const mutation = useMutation({
    mutationFn: () =>
      save({
        name: name.trim(),
        description: blankToNull(description),
        provider: provider === ANY ? null : (provider as MachineProvider),
        region: provider === "azure" ? blankToNull(region) : null,
        sizeSku: blankToNull(sizeSku),
        image: blankToNull(image),
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
            <span className="text-sm font-medium">Fixed for every machine on it</span>
            <span className="text-xs text-muted-foreground">
              {fieldsFixed
                ? `${profile?.machineCount} machine(s) use this profile, so these cannot change. Make a new profile instead.`
                : "Optional. Leave a field empty and the Add machine form asks for it."}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="profile-provider">Provider</Label>
              <Select value={provider} onValueChange={setProvider} disabled={fieldsFixed}>
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
              <Label htmlFor="profile-region">Region</Label>
              <Input
                id="profile-region"
                value={region}
                disabled={fieldsFixed || provider !== "azure"}
                onChange={(event) => setRegion(event.target.value)}
                placeholder={provider === "azure" ? "e.g. swedencentral" : "Azure only"}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="profile-size">Size</Label>
              <Input
                id="profile-size"
                value={sizeSku}
                disabled={fieldsFixed || provider === ANY}
                onChange={(event) => setSizeSku(event.target.value)}
                placeholder="e.g. Standard_D4s_v5"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="profile-image">Image</Label>
              <Input
                id="profile-image"
                value={image}
                disabled={fieldsFixed || provider === ANY}
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
