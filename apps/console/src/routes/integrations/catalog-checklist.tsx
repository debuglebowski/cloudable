import {
  type CatalogItem,
  useProviderCatalog,
  useSyncAzureRegions,
  useSyncAzureSizes,
  useToggleCatalogEntry,
} from "@/api/provider-catalog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

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
}: {
  title: string;
  kind: "region" | "image" | "sku";
  showSync?: boolean;
}) {
  const catalogQuery = useProviderCatalog("azure", kind);
  const toggle = useToggleCatalogEntry("azure", kind);
  // Both mutations are cheap to declare (a `useMutation` call sets up a
  // definition, it doesn't fire anything) — called unconditionally so the
  // choice below is a plain value pick, not a conditional hook call.
  const regionSync = useSyncAzureRegions();
  const sizeSync = useSyncAzureSizes();
  const sync = kind === "region" ? regionSync : sizeSync;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {showSync && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? "Syncing…" : "Sync from Azure"}
          </Button>
        )}
      </div>
      {catalogQuery.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
      {catalogQuery.data?.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing discovered yet{showSync ? " — sync from Azure first." : "."}
        </p>
      )}
      {catalogQuery.data && catalogQuery.data.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {catalogQuery.data.map((entry: CatalogItem) => (
            <li key={entry.code} className="flex items-center gap-2">
              <Checkbox
                id={`catalog-${kind}-${entry.code}`}
                checked={entry.enabled}
                disabled={toggle.isPending}
                onCheckedChange={() => toggle.mutate(entry)}
              />
              <label
                htmlFor={`catalog-${kind}-${entry.code}`}
                className="cursor-pointer text-xs font-normal"
              >
                {entry.displayName}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
