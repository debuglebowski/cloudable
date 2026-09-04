import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { CloudProvider } from "@/api/integrations";
import { useIntegrations } from "@/api/integrations";
import { createMachine, machinesKeys } from "@/api/machines";
import { listPeople } from "@/api/people-directory";
import { useProviderCatalog } from "@/api/provider-catalog";
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

const PROVIDER_LABEL: Record<CloudProvider, string> = {
  azure: "Azure",
  docker: "Docker",
  fake: "Fake",
};

/** Only Azure has a region concept or a curated image catalog — Docker/Fake
 * are regionless (the Region field is omitted outright, not disabled) and
 * take a freeform image string (Docker further constrains it to
 * "ubuntu-XX.YY" at the adapter level; Fake accepts anything). Size SKU is
 * a NOT NULL column for every provider (unlike region, which is genuinely
 * absent for non-Azure) — Docker/Fake still need a value, so the field is
 * hidden outright (same as Region) and silently defaults to
 * `DEFAULTS.sizeSku` rather than asking, since there's no real catalog or
 * freeform convention to offer them. */
function supportsRegion(provider: CloudProvider): boolean {
  return provider === "azure";
}
function hasImageCatalog(provider: CloudProvider): boolean {
  return provider === "azure";
}
function hasSizeCatalog(provider: CloudProvider): boolean {
  return provider === "azure";
}

const DEFAULTS = { sizeSku: "Standard_D2s_v5", image: "ubuntu-24.04" };

/**
 * Real `POST /api/v1/machines` — no scope-2 template picker (templates
 * don't exist in v1), no manifest editor (that's the machine detail
 * page's job, once the machine exists). Owner is required and picked from
 * the real `people` directory — a machine always
 * has exactly one owner, always a person, never omitted.
 */
export function AddMachineDialog({ open, onOpenChange }: AddMachineDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<CloudProvider | "">("");
  const [region, setRegion] = useState("");
  const [sizeSku, setSizeSku] = useState(DEFAULTS.sizeSku);
  const [image, setImage] = useState(DEFAULTS.image);
  const [ownerPersonId, setOwnerPersonId] = useState("");

  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeople,
    enabled: open,
  });
  const activePeople = (peopleQuery.data ?? []).filter((p) => p.active);

  const integrationsQuery = useIntegrations();
  const enabledProviders = (integrationsQuery.data ?? [])
    .filter((integration) => integration.kind === "cloud" && integration.removedAt === null)
    .map((integration) => integration.provider)
    .filter((p): p is CloudProvider => p !== null);

  const regionCatalogQuery = useProviderCatalog("azure", "region");
  const enabledRegions = (regionCatalogQuery.data ?? []).filter((entry) => entry.enabled);
  const imageCatalogQuery = useProviderCatalog("azure", "image");
  const enabledImages = (imageCatalogQuery.data ?? []).filter((entry) => entry.enabled);
  const sizeCatalogQuery = useProviderCatalog("azure", "sku");
  const enabledSizes = (sizeCatalogQuery.data ?? []).filter((entry) => entry.enabled);

  function handleProviderChange(next: CloudProvider) {
    setProvider(next);
    setRegion("");
    setImage(hasImageCatalog(next) ? "" : DEFAULTS.image);
    setSizeSku(hasSizeCatalog(next) ? "" : DEFAULTS.sizeSku);
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Provider is required");
      return createMachine({
        name: name.trim(),
        provider,
        ...(supportsRegion(provider) ? { region } : {}),
        sizeSku: sizeSku.trim(),
        image: image.trim(),
        ownerPersonId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setName("");
    setProvider("");
    setRegion("");
    setSizeSku(DEFAULTS.sizeSku);
    setImage(DEFAULTS.image);
    setOwnerPersonId("");
    mutation.reset();
  }

  const canSubmit =
    name.trim().length > 0 &&
    provider !== "" &&
    (!supportsRegion(provider) || region !== "") &&
    image.trim().length > 0 &&
    (!hasSizeCatalog(provider) || sizeSku !== "") &&
    ownerPersonId.length > 0 &&
    !mutation.isPending;

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
            <Label htmlFor="add-machine-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(value) => handleProviderChange(value as CloudProvider)}
            >
              <SelectTrigger id="add-machine-provider">
                <SelectValue
                  placeholder={
                    integrationsQuery.isLoading
                      ? "Loading…"
                      : enabledProviders.length === 0
                        ? "No providers enabled — see Integrations"
                        : "Select a provider"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {enabledProviders.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {PROVIDER_LABEL[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {provider && supportsRegion(provider) && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="add-machine-region">Region</Label>
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger id="add-machine-region">
                    <SelectValue
                      placeholder={
                        regionCatalogQuery.isLoading
                          ? "Loading…"
                          : enabledRegions.length === 0
                            ? "No regions enabled"
                            : "Select a region"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledRegions.map((entry) => (
                      <SelectItem key={entry.code} value={entry.code}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {provider && hasSizeCatalog(provider) && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="add-machine-size">Size SKU</Label>
                <Select value={sizeSku} onValueChange={setSizeSku}>
                  <SelectTrigger id="add-machine-size">
                    <SelectValue
                      placeholder={
                        sizeCatalogQuery.isLoading
                          ? "Loading…"
                          : enabledSizes.length === 0
                            ? "No sizes enabled"
                            : "Select a size"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledSizes.map((entry) => (
                      <SelectItem key={entry.code} value={entry.code}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-machine-image">Image</Label>
            {provider && hasImageCatalog(provider) ? (
              <Select value={image} onValueChange={setImage}>
                <SelectTrigger id="add-machine-image">
                  <SelectValue
                    placeholder={
                      imageCatalogQuery.isLoading
                        ? "Loading…"
                        : enabledImages.length === 0
                          ? "No images enabled"
                          : "Select an image"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {enabledImages.map((entry) => (
                    <SelectItem key={entry.code} value={entry.code}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="add-machine-image"
                required
                value={image}
                onChange={(event) => setImage(event.target.value)}
              />
            )}
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
