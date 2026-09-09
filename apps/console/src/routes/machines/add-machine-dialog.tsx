import { SiDocker } from "@icons-pack/react-simple-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  Cloud,
  Cpu,
  Disc,
  Drama,
  Loader2,
  type LucideIcon,
  MapPin,
  User,
} from "lucide-react";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type { CloudProvider } from "@/api/integrations";
import { useIntegrations } from "@/api/integrations";
import { createMachine, machinesKeys } from "@/api/machines";
import { listPeople } from "@/api/people-directory";
import type { CatalogItem } from "@/api/provider-catalog";
import { useProviderCatalog, useSyncAzureRegions, useSyncAzureSizes } from "@/api/provider-catalog";
import { useProvisioningCapabilities } from "@/api/provisioning-capabilities";
import { CollapsibleSection } from "@/components/collapsible-section";
import { OsIcon } from "@/components/os-icon";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { computeCompatibility, countCompatible } from "./machine-compatibility";
import { MachineSizeBrowser } from "./machine-size-browser";

export interface AddMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type WizardStep = 1 | 2 | 3 | 4;

const PROVIDER_LABEL: Record<CloudProvider, string> = {
  azure: "Azure",
  docker: "Docker",
  fake: "Fake",
};

const PROVIDER_BLURB: Record<CloudProvider, string> = {
  azure: "Region, image and size catalog",
  docker: "Freeform image, no catalog",
  fake: "Freeform image, no catalog",
};

/** Same brand marks as the Integrations page's own provider cards
 * (`routes/integrations/page.tsx`'s `AzureLogo`/`DockerLogo`) — duplicated as tiny
 * local equivalents rather than importing private, unexported helpers from that
 * page, so the two surfaces still read as the same providers at a glance. */
function AzureLogo({ className }: { className?: string }) {
  return <img src="/logos/azure.svg" alt="Azure" className={className} />;
}
function DockerLogo({ className }: { className?: string }) {
  return <SiDocker className={className} color="default" />;
}
// Wrapped the same way as AzureLogo/DockerLogo above (rather than referencing
// `Drama` directly) so all three share one exact prop signature — lucide's own
// `ForwardRefExoticComponent` type carries a wider `defaultProps` shape that
// doesn't line up with `ComponentType<{ className?: string }>` under this repo's
// `exactOptionalPropertyTypes`.
function FakeLogo({ className }: { className?: string }) {
  return <Drama className={className} />;
}
const PROVIDER_ICON: Record<CloudProvider, ComponentType<{ className?: string }>> = {
  azure: AzureLogo,
  docker: DockerLogo,
  fake: FakeLogo,
};

/** Only Azure has a region concept or a curated image catalog — Docker/Fake
 * are regionless (the Region field is omitted outright, not disabled) and
 * take a freeform image string. Size SKU is a NOT NULL column for every
 * provider (unlike region, which is genuinely absent for non-Azure) —
 * Docker/Fake still need a value, so the field is hidden outright (same as
 * Region) and silently defaults to `DEFAULTS.sizeSku` rather than asking,
 * since there's no real catalog or freeform convention to offer them. */
function supportsRegion(provider: CloudProvider): boolean {
  return provider === "azure";
}
function hasImageCatalog(provider: CloudProvider): boolean {
  return provider === "azure";
}
function hasSizeCatalog(provider: CloudProvider): boolean {
  return provider === "azure";
}

/** Mirrors `ProvisioningService.docker.ts`'s own `ubuntuVersionFor` regex exactly — that
 * service rejects anything else with a real `provider_error` at creation time
 * ("Local Docker only supports \"ubuntu-XX.YY\" images"). This isn't a container-registry
 * reference at all (no `docker pull` of arbitrary Hub images happens here): it names an
 * Ubuntu base-OS version, which the local dev provider bakes into a Cloudable-built image
 * alongside the compiled agent. A name like "nginx" or a registry URL would be accepted by
 * this field today and only fail later, mid-`docker build` — validating it here up front is
 * the same "disable what can't work, don't let the server find out" philosophy as every
 * other field in this wizard, not a new one. */
const DOCKER_UBUNTU_IMAGE_PATTERN = /^ubuntu-\d+\.\d+$/;

/** `fake` has no such constraint — `ProvisioningService.fake.ts` ignores `image` entirely
 * except for two exact dev-only sentinel strings (used to force a simulated create/verify
 * failure in tests), so any other value is genuinely, permanently valid for it. */
function isValidFreeformImage(provider: CloudProvider | "", image: string): boolean {
  const trimmed = image.trim();
  if (trimmed.length === 0) return false;
  if (provider === "docker") return DOCKER_UBUNTU_IMAGE_PATTERN.test(trimmed);
  return provider !== "";
}

const DEFAULTS = { sizeSku: "Standard_D2s_v5", image: "ubuntu-24.04" };

const STEP_TITLES: Record<WizardStep, string> = {
  1: "Provider & region",
  2: "Size & image",
  3: "Owner & name",
  4: "Review",
};

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  1: "Choose a provider and, for Azure, a region.",
  2: "Pick a size and an image — combinations that won't run together are disabled, not hidden.",
  3: "Name the machine and assign its one required owner.",
  4: "Review everything before creating.",
};

function isStep1Valid(
  provider: CloudProvider | "",
  lockedRegion: string | null,
  region: string,
): boolean {
  if (provider === "") return false;
  if (!supportsRegion(provider)) return true;
  return lockedRegion !== null || region !== "";
}

function isStep2Valid(
  provider: CloudProvider | "",
  sizeSku: string,
  image: string,
  selectedSize: CatalogItem | undefined,
  selectedImage: CatalogItem | undefined,
): boolean {
  if (provider === "") return false;
  if (provider !== "azure") return isValidFreeformImage(provider, image);
  if (!sizeSku || !image) return false;
  return computeCompatibility(selectedSize ?? null, selectedImage ?? null).compatible;
}

/** Right-rail-style key/value line for the Review step — a private local
 * equivalent of `machine-detail-page.tsx`'s own `PropertyRow` rather than an
 * export from that page, which stays untouched by this rework. `icon` is
 * optional: most rows carry one from the same set `PropertyRow`/
 * `TableHeaderIcon` already use elsewhere (Cloud/MapPin/Cpu/Disc/User), but
 * "Name" has no established icon anywhere in this app, so it renders with a
 * blank spacer instead of inventing one. */
function ReviewRow({
  icon: Icon,
  label,
  value,
}: {
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 text-sm">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {Icon ? <TableHeaderIcon icon={Icon} /> : <span className="size-3.5 shrink-0" />}
        {label}
      </dt>
      <dd className="truncate text-right">{value}</dd>
    </div>
  );
}

/**
 * Real `POST /api/v1/machines` — a four-step gated wizard, not a flat form: Azure's
 * live region/image/size catalog replaced per-org curation (see
 * `provider-catalog.ts`'s own doc comment on why), so this is now the one place any
 * of it happens, and it needs to disable combinations that don't actually run
 * together rather than let the server reject them after the fact. No scope-2
 * template picker (templates don't exist in v1), no manifest editor (that's the
 * machine detail page's job, once the machine exists). Owner is required and
 * picked from the real `people` directory — a machine always has exactly one
 * owner, always a person, never omitted.
 */
export function AddMachineDialog({ open, onOpenChange }: AddMachineDialogProps) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<WizardStep>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<WizardStep>(1);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<CloudProvider | "">("");
  const [region, setRegion] = useState("");
  const [regionPickerOpen, setRegionPickerOpen] = useState(false);
  const [sizeSku, setSizeSku] = useState(DEFAULTS.sizeSku);
  const [image, setImage] = useState(DEFAULTS.image);
  const [imageTouchedByUser, setImageTouchedByUser] = useState(false);
  const [ownerPersonId, setOwnerPersonId] = useState("");

  const peopleQuery = useQuery({
    queryKey: ["people-directory"],
    queryFn: listPeople,
    enabled: open,
  });
  const activePeople = (peopleQuery.data ?? []).filter((p) => p.active);

  const integrationsQuery = useIntegrations();
  const enabledProviders = useMemo(
    () =>
      (integrationsQuery.data ?? [])
        .filter((integration) => integration.kind === "cloud" && integration.removedAt === null)
        .map((integration) => integration.provider)
        .filter((p): p is CloudProvider => p !== null),
    [integrationsQuery.data],
  );

  // Default to the first enabled provider once the list loads — never overrides an
  // explicit user pick (guarded on `provider === ""`), and covers the single
  // -provider case that renders as a non-interactive fact row below (nothing to
  // choose, but the wizard still needs a value to gate on).
  useEffect(() => {
    if (provider !== "") return;
    const first = enabledProviders[0];
    if (!first) return;
    setProvider(first);
    setSizeSku(hasSizeCatalog(first) ? "" : DEFAULTS.sizeSku);
    setImage(hasImageCatalog(first) ? "" : DEFAULTS.image);
  }, [enabledProviders, provider]);

  const capabilitiesQuery = useProvisioningCapabilities();
  const lockedRegion = capabilitiesQuery.data?.azure.lockedRegion ?? null;
  const regionCatalogQuery = useProviderCatalog("azure", "region");
  const regions = regionCatalogQuery.data ?? [];
  const imageCatalogQuery = useProviderCatalog("azure", "image");
  const images = imageCatalogQuery.data ?? [];
  const sizeCatalogQuery = useProviderCatalog("azure", "sku");
  const sizes = sizeCatalogQuery.data ?? [];
  const regionSync = useSyncAzureRegions();
  const sizeSync = useSyncAzureSizes();

  // Only meaningful when exactly one provider is enabled — renders as a
  // non-interactive fact row below instead of a one-item RadioGroup.
  const soleProvider = enabledProviders.length === 1 ? enabledProviders[0] : undefined;

  const selectedRegion = regions.find((entry) => entry.code === region);
  const selectedImage = images.find((entry) => entry.code === image);
  const selectedSize = sizes.find((entry) => entry.code === sizeSku);

  function handleProviderChange(next: CloudProvider) {
    setProvider(next);
    setRegion("");
    setSizeSku(hasSizeCatalog(next) ? "" : DEFAULTS.sizeSku);
    setImage(hasImageCatalog(next) ? "" : DEFAULTS.image);
    setImageTouchedByUser(false);
  }

  function handleImageSelect(code: string) {
    setImage(code);
    setImageTouchedByUser(true);
    // No conflict-clearing needed here (unlike `handleSizeSelect` below): an image
    // that conflicts with the current size is already `disabled` in the RadioGroup
    // below, so it can't be reached through the UI in the first place.
  }

  function handleSizeSelect(sku: string) {
    setSizeSku(sku);
    if (imageTouchedByUser) return;
    // Auto-resolve, one direction only (never the reverse — with 1000+ sizes,
    // auto-picking a specific SKU from an image click is the wrong default even in
    // principle): once a size is picked, if exactly one catalog image remains
    // compatible with it, select that one for the user. Inert today — both real
    // images require x64, so two remain compatible either way — and activates the
    // day a second, differently-profiled image exists.
    const sizeEntry = sizes.find((entry) => entry.code === sku);
    const compatibleImages = images.filter(
      (entry) => computeCompatibility(sizeEntry ?? null, entry).compatible,
    );
    const onlyCompatibleImage = compatibleImages.length === 1 ? compatibleImages[0] : undefined;
    if (onlyCompatibleImage) {
      setImage(onlyCompatibleImage.code);
    } else if (image && !compatibleImages.some((entry) => entry.code === image)) {
      // A previously auto-resolved image no longer fits this size — clear it
      // rather than leave a silently-invalid pair selected.
      setImage("");
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Provider is required");
      return createMachine({
        ...(name.trim() ? { name: name.trim() } : {}),
        provider,
        // When the deployment locks the region, don't send one at all — the
        // server forces it regardless, and sending our (possibly stale/empty)
        // local `region` state would just be misleading.
        ...(supportsRegion(provider) && !lockedRegion ? { region } : {}),
        sizeSku: sizeSku.trim(),
        image: image.trim(),
        ownerPersonId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
      resetWizard();
      onOpenChange(false);
    },
  });

  function resetWizard() {
    setStep(1);
    setMaxReachedStep(1);
    setName("");
    setProvider("");
    setRegion("");
    setSizeSku(DEFAULTS.sizeSku);
    setImage(DEFAULTS.image);
    setImageTouchedByUser(false);
    setOwnerPersonId("");
    mutation.reset();
  }

  const step1Valid = isStep1Valid(provider, lockedRegion, region);
  const step2Valid = isStep2Valid(provider, sizeSku, image, selectedSize, selectedImage);
  const step3Valid = ownerPersonId !== "";
  const currentStepValid =
    step === 1 ? step1Valid : step === 2 ? step2Valid : step === 3 ? step3Valid : true;

  function goNext() {
    if (step === 4 || !currentStepValid) return;
    const next = (step + 1) as WizardStep;
    setStep(next);
    setMaxReachedStep((current) => (current > next ? current : next));
  }

  function handleStepChange(value: string) {
    if (mutation.isPending) return;
    const target = Number(value) as WizardStep;
    if (target <= maxReachedStep) setStep(target);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending) return;
    if (step === 4) {
      mutation.mutate();
      return;
    }
    goNext();
  }

  const disableNav = mutation.isPending;

  // Shared by the Dialog's own onOpenChange (Escape, overlay click, the built-in X)
  // and the footer's Cancel button — Radix only invokes a controlled component's
  // onOpenChange for its own internally-triggered closes, never just because the
  // `open` prop was flipped externally by a parent, so Cancel must not call
  // `onOpenChange(false)` directly or the reset below gets skipped and a reopened
  // dialog shows stale wizard state.
  function handleClose() {
    resetWizard();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetWizard();
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-[900px]">
        <DialogHeader className="gap-1.5 border-b px-6 pb-4 pt-6 text-left">
          <DialogTitle>Add machine</DialogTitle>
          <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <Tabs value={String(step)} onValueChange={handleStepChange}>
            <div className="px-6 pt-4">
              <TabsList className="grid w-full grid-cols-4">
                {([1, 2, 3, 4] as WizardStep[]).map((n) => (
                  <TabsTrigger key={n} value={String(n)} disabled={n > maxReachedStep}>
                    <span className="flex items-center gap-1.5">
                      {n < step ? (
                        <Check className="size-3.5" />
                      ) : (
                        <span className="tabular-nums">{n}</span>
                      )}
                      <span className="hidden sm:inline">{STEP_TITLES[n]}</span>
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <div className="max-h-[65vh] overflow-y-auto px-6 py-5">
              <TabsContent value="1" className="mt-0 flex flex-col gap-8">
                <div className="flex flex-col gap-2">
                  <Label className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Cloud} />
                    Provider
                  </Label>
                  {integrationsQuery.isLoading ? (
                    <div className="flex flex-col gap-2">
                      <Skeleton className="h-16 w-full rounded-lg" />
                      <Skeleton className="h-16 w-full rounded-lg" />
                    </div>
                  ) : enabledProviders.length === 0 ? (
                    <EmptyState
                      icon={Cloud}
                      title="No providers enabled"
                      description="Enable a cloud provider from Integrations before creating a machine."
                    />
                  ) : soleProvider ? (
                    <ProviderOptionRow provider={soleProvider} />
                  ) : (
                    <RadioGroup
                      value={provider}
                      onValueChange={(value) => handleProviderChange(value as CloudProvider)}
                    >
                      {enabledProviders.map((candidate) => (
                        <label
                          key={candidate}
                          htmlFor={`add-machine-provider-${candidate}`}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50",
                            provider === candidate && "border-ring ring-2 ring-ring",
                          )}
                        >
                          <RadioGroupItem
                            value={candidate}
                            id={`add-machine-provider-${candidate}`}
                          />
                          <ProviderOptionRow provider={candidate} bare />
                        </label>
                      ))}
                    </RadioGroup>
                  )}
                </div>

                {provider && supportsRegion(provider) && (
                  <div className="flex flex-col gap-2">
                    <Label className="flex items-center gap-1.5">
                      <TableHeaderIcon icon={MapPin} />
                      Region
                    </Label>
                    {lockedRegion ? (
                      <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                        <span>{lockedRegion}</span>
                        <Badge variant="outline">Fixed for this deployment</Badge>
                      </div>
                    ) : regionCatalogQuery.isLoading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : regions.length === 0 ? (
                      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-6">
                        <EmptyState
                          icon={MapPin}
                          title="No regions synced yet"
                          description="Sync live regions from Azure to choose one."
                          className="py-0"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => regionSync.mutate()}
                          disabled={regionSync.isPending}
                        >
                          {regionSync.isPending && <Loader2 className="size-3.5 animate-spin" />}
                          {regionSync.isPending ? "Syncing…" : "Sync from Azure"}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {/* Mid-sync, this stays fully rendered but unreactive — the sync
                            can take a while and the catalog underneath it is about to
                            change, so picking against it right now would just be picking
                            against soon-to-be-stale data. */}
                        <div
                          className={cn(
                            "flex-1",
                            regionSync.isPending && "pointer-events-none opacity-60",
                          )}
                          aria-disabled={regionSync.isPending || undefined}
                        >
                          <Popover open={regionPickerOpen} onOpenChange={setRegionPickerOpen}>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                // biome-ignore lint/a11y/useSemanticElements: standard shadcn/Radix
                                // combobox pattern (Popover + Command over a button) — a native
                                // <select> can't render a searchable list.
                                role="combobox"
                                aria-expanded={regionPickerOpen}
                                className="w-full justify-between font-normal"
                              >
                                <span className="truncate">
                                  {selectedRegion ? selectedRegion.displayName : "Select a region"}
                                </span>
                                <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[26rem] p-0" align="start">
                              <Command>
                                <CommandInput placeholder="Search regions…" />
                                <CommandList>
                                  <CommandEmpty>No matches.</CommandEmpty>
                                  <CommandGroup>
                                    {regions.map((entry) => (
                                      <CommandItem
                                        key={entry.code}
                                        value={entry.displayName}
                                        onSelect={() => {
                                          setRegion(entry.code);
                                          setRegionPickerOpen(false);
                                        }}
                                      >
                                        <Check
                                          className={cn(
                                            "size-4",
                                            entry.code === region ? "opacity-100" : "opacity-0",
                                          )}
                                        />
                                        <span className="truncate">{entry.displayName}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5"
                          onClick={() => regionSync.mutate()}
                          disabled={regionSync.isPending}
                        >
                          {regionSync.isPending && <Loader2 className="size-3.5 animate-spin" />}
                          {regionSync.isPending ? "Syncing…" : "Sync from Azure"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {provider && !supportsRegion(provider) && (
                  <p className="text-sm text-muted-foreground">
                    Docker and Fake machines are regionless — size and image are set directly in the
                    next step.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="2" className="mt-0 flex flex-col gap-8">
                {provider === "azure" ? (
                  <>
                    <div className="flex flex-col gap-3">
                      <Label className="flex items-center gap-1.5">
                        <TableHeaderIcon icon={Disc} />
                        Image
                      </Label>
                      {imageCatalogQuery.isLoading ? (
                        <div className="grid grid-cols-2 gap-3">
                          <Skeleton className="h-16 w-full rounded-lg" />
                          <Skeleton className="h-16 w-full rounded-lg" />
                        </div>
                      ) : images.length === 0 ? (
                        <EmptyState
                          icon={Disc}
                          title="No images discovered"
                          description="No Azure images are configured on this deployment."
                        />
                      ) : (
                        <RadioGroup
                          value={image}
                          onValueChange={handleImageSelect}
                          className="grid grid-cols-2 gap-3"
                        >
                          {images.map((entry) => {
                            const compatibility = computeCompatibility(entry, selectedSize ?? null);
                            return (
                              <label
                                key={entry.code}
                                htmlFor={`add-machine-image-${entry.code}`}
                                className={cn(
                                  "flex flex-col gap-2 rounded-lg border p-4 transition-colors",
                                  compatibility.compatible
                                    ? "cursor-pointer hover:bg-accent/50"
                                    : "cursor-not-allowed opacity-50",
                                  image === entry.code && "border-ring ring-2 ring-ring",
                                )}
                              >
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem
                                    value={entry.code}
                                    id={`add-machine-image-${entry.code}`}
                                    disabled={!compatibility.compatible}
                                  />
                                  <OsIcon image={entry.code} className="size-4 shrink-0" />
                                  <span className="flex-1 truncate text-sm font-medium">
                                    {entry.displayName}
                                  </span>
                                  {/* Top-right of the card, in the same row as the name — the
                                      architecture is a property OF this image, not a separate
                                      fact below it. */}
                                  {compatibility.compatible ? (
                                    <Badge variant="outline" className="w-fit shrink-0">
                                      {entry.architecture ?? "—"}
                                    </Badge>
                                  ) : (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Badge
                                          variant="drift"
                                          className="pointer-events-auto w-fit shrink-0"
                                        >
                                          {compatibility.reason}
                                        </Badge>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        {entry.displayName} requires {entry.architecture} —
                                        incompatible with the selected size, which requires{" "}
                                        {selectedSize?.architecture}.
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                                {/* Bottom-left, against the whole synced catalog (not whatever the
                                    Size browser below happens to be filtered to right now) — lets
                                    you compare images by real compatibility breadth before picking
                                    either one, instead of only seeing a count once one is already
                                    selected. Omitted entirely pre-sync rather than showing a
                                    misleading "0 of 0". */}
                                {sizes.length > 0 && (
                                  <span className="text-xs text-muted-foreground">
                                    Compatible with {countCompatible(sizes, entry)} of{" "}
                                    {sizes.length} sizes
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </RadioGroup>
                      )}
                    </div>

                    {!lockedRegion && !region ? (
                      <div className="flex flex-col gap-3">
                        <Label className="flex items-center gap-1.5">
                          <TableHeaderIcon icon={Cpu} />
                          Size
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Choose a region first — sizes are synced per location.
                        </p>
                      </div>
                    ) : (
                      // Owns its own "Size" label (paired with the live count) instead of
                      // taking it as a prop — see machine-size-browser.tsx.
                      <MachineSizeBrowser
                        sizes={sizes}
                        isLoading={sizeCatalogQuery.isLoading}
                        selectedSizeSku={sizeSku || null}
                        onSelectSize={handleSizeSelect}
                        selectedImage={selectedImage ?? null}
                        onSync={() => sizeSync.mutate()}
                        isSyncing={sizeSync.isPending}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex flex-col gap-3">
                    <Label
                      htmlFor="add-machine-image-freeform"
                      className="flex items-center gap-1.5"
                    >
                      <TableHeaderIcon icon={Disc} />
                      Image
                    </Label>
                    <Input
                      id="add-machine-image-freeform"
                      required
                      value={image}
                      onChange={(event) => setImage(event.target.value)}
                      placeholder="e.g. ubuntu-24.04"
                      aria-invalid={
                        image.trim().length > 0 && !isValidFreeformImage(provider, image)
                      }
                    />
                    {/* Not a container-registry reference (no image name or URL is pulled from
                        a hub here) — see DOCKER_UBUNTU_IMAGE_PATTERN's own comment. Copy is
                        provider-specific because the two providers' real constraints genuinely
                        differ: docker enforces an exact pattern server-side, fake ignores the
                        value entirely. */}
                    {provider === "docker" ? (
                      <p className="text-sm text-muted-foreground">
                        Local Docker only runs Ubuntu, named as{" "}
                        <span className="font-mono text-xs">ubuntu-&lt;version&gt;</span> (e.g.{" "}
                        <span className="font-mono text-xs">ubuntu-24.04</span>) — not a general
                        image name or registry URL.
                        {image.trim().length > 0 && !isValidFreeformImage(provider, image) && (
                          <span className="mt-1 block text-destructive">
                            Doesn't match{" "}
                            <span className="font-mono text-xs">ubuntu-&lt;version&gt;</span>.
                          </span>
                        )}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        The Fake provider doesn't run anything real — any value is accepted and
                        stored as-is.
                      </p>
                    )}
                    <p className="text-sm text-muted-foreground">
                      Docker and Fake machines don't use a size catalog — a sensible default is
                      applied automatically.
                    </p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="3" className="mt-0 flex flex-col gap-8">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="add-machine-owner" className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={User} />
                    Owner <span className="text-destructive">(required)</span>
                  </Label>
                  {peopleQuery.isLoading ? (
                    <Skeleton className="h-9 w-full" />
                  ) : activePeople.length === 0 ? (
                    <EmptyState
                      icon={User}
                      title="No active people found"
                      description="Add a person to the directory before creating a machine."
                    />
                  ) : (
                    <Select value={ownerPersonId} onValueChange={setOwnerPersonId}>
                      <SelectTrigger id="add-machine-owner">
                        <SelectValue placeholder="Select a person" />
                      </SelectTrigger>
                      <SelectContent>
                        {activePeople.map((person) => (
                          <SelectItem key={person.id} value={person.id}>
                            {person.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="add-machine-name">Name</Label>
                  <Input
                    id="add-machine-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Leave blank to auto-generate"
                  />
                </div>
              </TabsContent>

              <TabsContent value="4" className="mt-0 flex flex-col">
                <CollapsibleSection
                  label="Provider & region"
                  headerAction={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={disableNav}
                      onClick={() => setStep(1)}
                    >
                      Edit
                    </Button>
                  }
                >
                  <ReviewRow
                    icon={Cloud}
                    label="Provider"
                    value={provider ? PROVIDER_LABEL[provider] : "—"}
                  />
                  {provider && supportsRegion(provider) && (
                    <ReviewRow
                      icon={MapPin}
                      label="Region"
                      value={
                        lockedRegion ? (
                          <Badge variant="outline">Fixed for this deployment</Badge>
                        ) : (
                          (selectedRegion?.displayName ?? region ?? "—")
                        )
                      }
                    />
                  )}
                </CollapsibleSection>

                <Separator />

                <CollapsibleSection
                  label="Size & image"
                  headerAction={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={disableNav}
                      onClick={() => setStep(2)}
                    >
                      Edit
                    </Button>
                  }
                >
                  {provider === "azure" ? (
                    <>
                      <ReviewRow
                        icon={Disc}
                        label="Image"
                        value={
                          selectedImage ? (
                            <span className="flex items-center justify-end gap-1.5">
                              <OsIcon image={selectedImage.code} className="size-3.5 shrink-0" />
                              {selectedImage.displayName}
                              {selectedImage.architecture && (
                                <Badge variant="outline">{selectedImage.architecture}</Badge>
                              )}
                            </span>
                          ) : (
                            "—"
                          )
                        }
                      />
                      <ReviewRow
                        icon={Cpu}
                        label="Size"
                        value={
                          selectedSize ? (
                            <span>
                              {selectedSize.displayName}{" "}
                              <span className="text-muted-foreground">
                                · {selectedSize.vcpus ?? "—"} vCPU · {selectedSize.memoryGb ?? "—"}{" "}
                                GB
                              </span>
                            </span>
                          ) : (
                            "—"
                          )
                        }
                      />
                    </>
                  ) : (
                    <ReviewRow icon={Disc} label="Image" value={image || "—"} />
                  )}
                </CollapsibleSection>

                <Separator />

                <CollapsibleSection
                  label="Owner & name"
                  headerAction={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={disableNav}
                      onClick={() => setStep(3)}
                    >
                      Edit
                    </Button>
                  }
                >
                  <ReviewRow
                    icon={User}
                    label="Owner"
                    value={activePeople.find((p) => p.id === ownerPersonId)?.email ?? "—"}
                  />
                  <ReviewRow label="Name" value={name.trim() || "Auto-generated"} />
                </CollapsibleSection>

                {provider === "azure" &&
                  selectedImage &&
                  selectedSize &&
                  computeCompatibility(selectedSize, selectedImage).compatible && (
                    <Badge variant="ok" className="mt-3 w-fit gap-1">
                      <Check className="size-3" />
                      Image and size architectures match
                    </Badge>
                  )}
              </TabsContent>
            </div>
          </Tabs>

          <div className="border-t">
            {mutation.isError && (
              <p className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
              </p>
            )}
            <DialogFooter className="px-6 py-4 sm:justify-between">
              <Button type="button" variant="ghost" onClick={handleClose} disabled={disableNav}>
                Cancel
              </Button>
              <div className="flex gap-2">
                {step > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep((current) => (current - 1) as WizardStep)}
                    disabled={disableNav}
                  >
                    Back
                  </Button>
                )}
                {step < 4 ? (
                  <Button type="button" onClick={goNext} disabled={!currentStepValid}>
                    Next
                  </Button>
                ) : (
                  // Deliberately `type="button"`, not `type="submit"` — this slot previously
                  // swapped from the Next button's `type="button"` to `type="submit"` here,
                  // and React patches the existing DOM node in place rather than remounting
                  // it. That meant the very click on "Next" that advanced step 3 -> 4 could
                  // also flip this node's type mid-dispatch, so the browser's native
                  // submit-button activation fired on that same click and created the
                  // machine immediately — closing the dialog before Review ever rendered,
                  // skipping the one mandatory checkpoint this wizard exists to add. Calling
                  // the mutation directly from onClick removes the footgun: no button in this
                  // footer is ever a submit button, so no click can be mistaken for one.
                  <Button
                    type="button"
                    onClick={() => mutation.mutate()}
                    disabled={mutation.isPending}
                  >
                    {mutation.isPending ? "Creating…" : "Create machine"}
                  </Button>
                )}
              </div>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Provider row content shared by the single-provider fact row and each
 * multi-provider RadioGroup card — `bare` drops the card's own border/padding when
 * it's already nested inside the RadioGroup's `<label>` wrapper above. */
function ProviderOptionRow({ provider, bare }: { provider: CloudProvider; bare?: boolean }) {
  const Icon = PROVIDER_ICON[provider];
  return (
    <div className={cn("flex flex-1 items-center gap-3", !bare && "rounded-lg border p-3")}>
      <Icon className="size-5 shrink-0" />
      <div className="flex flex-1 flex-col">
        <span className="text-sm font-medium">{PROVIDER_LABEL[provider]}</span>
        <span className="text-xs text-muted-foreground">{PROVIDER_BLURB[provider]}</span>
      </div>
      <Badge variant="outline">{hasImageCatalog(provider) ? "Full catalog" : "Freeform"}</Badge>
    </div>
  );
}
