import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import type { CloudProvider } from "@/api/integrations";
import { useIntegrations } from "@/api/integrations";
import { createMachine, machinesKeys } from "@/api/machines";
import { listPeople } from "@/api/people-directory";
import type { CatalogItem } from "@/api/provider-catalog";
import { useProviderCatalog } from "@/api/provider-catalog";
import { useProvisioningCapabilities } from "@/api/provisioning-capabilities";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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

/** Two catalog entries are compatible when neither carries an architecture
 * that contradicts the other — missing data on either side is never treated
 * as a mismatch (only a real, known conflict disables an option). This is
 * the mechanism that replaces per-org catalog curation (see
 * `provider-catalog.ts`'s doc comment): real Azure capability data compared
 * live, not an admin-maintained allow-list that can silently drift out of
 * sync with what actually works. It's a near no-op today — every image this
 * deployment offers requires the same architecture — and becomes load
 * -bearing the moment that stops being true. */
function isCompatible(a: { architecture: string | null }, b: { architecture: string | null }) {
  if (!a.architecture || !b.architecture) return true;
  return a.architecture === b.architecture;
}

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
  const [sizeComboOpen, setSizeComboOpen] = useState(false);
  const [sizeSearch, setSizeSearch] = useState("");
  const [minVcpus, setMinVcpus] = useState("");
  const [minMemoryGb, setMinMemoryGb] = useState("");

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

  const capabilitiesQuery = useProvisioningCapabilities();
  const lockedRegion = capabilitiesQuery.data?.azure.lockedRegion ?? null;
  const regionCatalogQuery = useProviderCatalog("azure", "region");
  const regions = regionCatalogQuery.data ?? [];
  const imageCatalogQuery = useProviderCatalog("azure", "image");
  const images = imageCatalogQuery.data ?? [];
  const sizeCatalogQuery = useProviderCatalog("azure", "sku");
  const sizes = sizeCatalogQuery.data ?? [];

  const selectedImage = images.find((entry) => entry.code === image);
  const selectedSize = sizes.find((entry) => entry.code === sizeSku);

  const minVcpusNum = minVcpus ? Number(minVcpus) : null;
  const minMemoryGbNum = minMemoryGb ? Number(minMemoryGb) : null;
  const filteredSizes = sizes.filter(
    (entry) =>
      entry.displayName.toLowerCase().includes(sizeSearch.toLowerCase()) &&
      (minVcpusNum === null || (entry.vcpus ?? 0) >= minVcpusNum) &&
      (minMemoryGbNum === null || (entry.memoryGb ?? 0) >= minMemoryGbNum),
  );

  function handleProviderChange(next: CloudProvider) {
    setProvider(next);
    setRegion("");
    setImage(hasImageCatalog(next) ? "" : DEFAULTS.image);
    setSizeSku(hasSizeCatalog(next) ? "" : DEFAULTS.sizeSku);
  }

  function handleImageChange(next: string) {
    setImage(next);
    const nextEntry = images.find((entry) => entry.code === next);
    // The already-selected size might not actually pair with the new image
    // (only matters once a second, differently-profiled image ever exists —
    // today every image shares the same requirement) — don't leave a
    // silently-invalid pair selected.
    if (nextEntry && selectedSize && !isCompatible(nextEntry, selectedSize)) {
      setSizeSku("");
    }
  }

  function handleSizeChange(next: CatalogItem) {
    setSizeSku(next.code);
    setSizeComboOpen(false);
    if (selectedImage && !isCompatible(next, selectedImage)) {
      setImage("");
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Provider is required");
      return createMachine({
        ...(name.trim() ? { name: name.trim() } : {}),
        provider,
        // When the deployment locks the region, don't send one at all —
        // the server forces it regardless, and sending our (possibly
        // stale/empty) local `region` state would just be misleading.
        ...(supportsRegion(provider) && !lockedRegion ? { region } : {}),
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
    setSizeSearch("");
    setMinVcpus("");
    setMinMemoryGb("");
    mutation.reset();
  }

  const canSubmit =
    provider !== "" &&
    (!supportsRegion(provider) || lockedRegion !== null || region !== "") &&
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
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Leave blank to auto-generate"
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
            {provider && supportsRegion(provider) && lockedRegion && (
              <div className="flex flex-col gap-1">
                <Label>Region</Label>
                <p className="flex h-9 items-center text-sm text-muted-foreground">
                  {lockedRegion} <span className="ml-1">(fixed for this deployment)</span>
                </p>
              </div>
            )}
            {provider && supportsRegion(provider) && !lockedRegion && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="add-machine-region">Region</Label>
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger id="add-machine-region">
                    <SelectValue
                      placeholder={
                        regionCatalogQuery.isLoading
                          ? "Loading…"
                          : regions.length === 0
                            ? "No regions discovered"
                            : "Select a region"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {regions.map((entry) => (
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
                <Popover open={sizeComboOpen} onOpenChange={setSizeComboOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="add-machine-size"
                      type="button"
                      variant="outline"
                      // biome-ignore lint/a11y/useSemanticElements: a native <select> can't
                      // render a searchable, disableable-per-item list — this is the standard
                      // shadcn/Radix combobox pattern (Popover + Command over a button).
                      role="combobox"
                      aria-expanded={sizeComboOpen}
                      className="justify-between font-normal"
                    >
                      <span className="truncate">
                        {selectedSize
                          ? selectedSize.displayName
                          : sizeCatalogQuery.isLoading
                            ? "Loading…"
                            : "Select a size"}
                      </span>
                      <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-96 p-0">
                    <div className="flex gap-2 border-b p-2">
                      <Input
                        type="number"
                        min={0}
                        value={minVcpus}
                        onChange={(event) => setMinVcpus(event.target.value)}
                        placeholder="Min vCPUs"
                        className="h-7 text-xs"
                      />
                      <Input
                        type="number"
                        min={0}
                        value={minMemoryGb}
                        onChange={(event) => setMinMemoryGb(event.target.value)}
                        placeholder="Min RAM (GB)"
                        className="h-7 text-xs"
                      />
                    </div>
                    <Command shouldFilter={false}>
                      <CommandInput
                        value={sizeSearch}
                        onValueChange={setSizeSearch}
                        placeholder="Search sizes…"
                      />
                      <CommandList>
                        <CommandEmpty>No matches.</CommandEmpty>
                        <CommandGroup>
                          {filteredSizes.map((entry) => {
                            const compatible = !selectedImage || isCompatible(entry, selectedImage);
                            return (
                              <CommandItem
                                key={entry.code}
                                value={entry.code}
                                disabled={!compatible}
                                onSelect={() => compatible && handleSizeChange(entry)}
                              >
                                <Check
                                  className={cn(
                                    "size-4",
                                    entry.code === sizeSku ? "opacity-100" : "opacity-0",
                                  )}
                                />
                                <span className="flex-1 truncate">{entry.displayName}</span>
                                {!compatible && (
                                  <span className="text-xs text-muted-foreground">
                                    requires {selectedImage?.architecture}
                                  </span>
                                )}
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-machine-image">Image</Label>
            {provider && hasImageCatalog(provider) ? (
              <Select value={image} onValueChange={handleImageChange}>
                <SelectTrigger id="add-machine-image">
                  <SelectValue
                    placeholder={
                      imageCatalogQuery.isLoading
                        ? "Loading…"
                        : images.length === 0
                          ? "No images discovered"
                          : "Select an image"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {images.map((entry) => {
                    const compatible = !selectedSize || isCompatible(entry, selectedSize);
                    return (
                      <SelectItem key={entry.code} value={entry.code} disabled={!compatible}>
                        {entry.displayName}
                        {!compatible ? ` (requires ${selectedSize?.architecture})` : ""}
                      </SelectItem>
                    );
                  })}
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
