import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import {
  type CatalogItem,
  useProviderCatalog,
  useSyncAzureRegions,
  useSyncAzureSizes,
  useToggleCatalogEntry,
} from "@/api/provider-catalog";
import { useProvisioningCapabilities } from "@/api/provisioning-capabilities";
import { CollapsibleSection } from "@/components/collapsible-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Checklist over a fixed, discovered catalog — checkbox per entry, not
 * add/remove-by-name (unlike `OrgPackageManifestCard`'s freeform list): the
 * universe here is "what does Azure actually offer," not org-typed names.
 * Nested inside the Azure `IntegrationCard` (only meaningful once Azure is
 * enabled) rather than living on the Organisation page — see
 * `docs/frontend.md`'s Integrations-page note.
 */
export function CatalogChecklist({
  title,
  kind,
  showSync,
  defaultOpen = true,
  lockedRegion,
}: {
  title: string;
  kind: "region" | "image" | "sku";
  showSync?: boolean;
  defaultOpen?: boolean;
  /** Only meaningful for `kind === "region"` — mirrors `AZURE_MACHINES_LOCATION`.
   * When set, this deployment has exactly one usable region, so the
   * interactive checklist (which an org's own selections could still drift
   * out of sync with — seen live) is replaced by a static notice instead. */
  lockedRegion?: string | null;
}) {
  const catalogQuery = useProviderCatalog("azure", kind);
  const toggle = useToggleCatalogEntry("azure", kind);
  // Both mutations are cheap to declare (a `useMutation` call sets up a
  // definition, it doesn't fire anything) — called unconditionally so the
  // choice below is a plain value pick, not a conditional hook call.
  const regionSync = useSyncAzureRegions();
  const sizeSync = useSyncAzureSizes();
  const sync = kind === "region" ? regionSync : sizeSync;
  const hasEnabled = catalogQuery.data?.some((entry) => entry.enabled) ?? false;
  const [search, setSearch] = useState("");
  const filtered = catalogQuery.data?.filter((entry) =>
    entry.displayName.toLowerCase().includes(search.toLowerCase()),
  );

  const regionIsLocked = kind === "region" && Boolean(lockedRegion);

  return (
    <CollapsibleSection
      label={
        <span className="flex items-center gap-1.5">
          {title}
          {(hasEnabled || regionIsLocked) && (
            <CheckCircle2 className="size-3.5 text-ok" aria-label={`${title} configured`} />
          )}
        </span>
      }
      headerAction={
        showSync &&
        !regionIsLocked && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? "Syncing…" : "Sync from Azure"}
          </Button>
        )
      }
      defaultOpen={defaultOpen}
      className="rounded-md border border-border px-2.5"
    >
      {regionIsLocked && (
        <p className="text-xs text-muted-foreground">
          This deployment only provisions in <span className="font-medium">{lockedRegion}</span> —
          region is fixed by <code className="text-[11px]">AZURE_MACHINES_LOCATION</code> and isn't
          configurable per org.
        </p>
      )}
      {!regionIsLocked && catalogQuery.isPending && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
      {!regionIsLocked && catalogQuery.data?.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing discovered yet{showSync ? " — sync from Azure first." : "."}
        </p>
      )}
      {!regionIsLocked && catalogQuery.data && catalogQuery.data.length > 0 && (
        <>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${title.toLowerCase()}…`}
            className="h-7 text-xs"
          />
          {filtered?.length === 0 && (
            <p className="text-xs text-muted-foreground">No matches for “{search}”.</p>
          )}
          <ul className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
            {filtered?.map((entry: CatalogItem) => (
              <li key={entry.code} className="flex items-center gap-2">
                <Checkbox
                  id={`catalog-${kind}-${entry.code}`}
                  checked={entry.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={() => toggle.mutate(entry)}
                />
                <label
                  htmlFor={`catalog-${kind}-${entry.code}`}
                  className="cursor-pointer truncate text-xs font-normal"
                  title={entry.displayName}
                >
                  {entry.displayName}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </CollapsibleSection>
  );
}

/** The Azure card's "Configure" action — regions/images/sizes used to render inline
 * on the card itself; every other integration card is a one- or two-line summary, so
 * this pulls the one heavy exception behind a modal instead. */
export function AzureCatalogDialog() {
  const capabilitiesQuery = useProvisioningCapabilities();
  const lockedRegion = capabilitiesQuery.data?.azure.lockedRegion ?? null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Configure
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Azure catalog</DialogTitle>
          <DialogDescription>
            Regions, images, and sizes this org allows machines to be created with.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[80vh] flex-col gap-2 overflow-y-auto">
          <CatalogChecklist
            title="Regions"
            kind="region"
            showSync
            defaultOpen
            lockedRegion={lockedRegion}
          />
          <CatalogChecklist title="Images" kind="image" defaultOpen={false} />
          <CatalogChecklist title="Sizes" kind="sku" showSync defaultOpen={false} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
