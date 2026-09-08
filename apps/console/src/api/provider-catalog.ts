import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api-client";

/**
 * The real, fully-synced region/image/size catalog for machine creation —
 * see `apps/control-plane/src/services/CloudCatalogService.ts` and
 * `packages/schema/src/tables/provider-catalog.ts`'s doc comment. No
 * per-org curation (retired — an admin-maintained allow-list could drift
 * out of sync with what actually works, which is exactly what kept
 * happening): the Add Machine form reads this directly and computes
 * compatibility itself from `vcpus`/`memoryGb`/`architecture`. Azure only
 * today (docker/fake are regionless and freeform-image/size, per
 * `add-machine-dialog.tsx`'s own `supportsRegion`/`hasImageCatalog`/
 * `hasSizeCatalog`), but the path is provider-generic.
 */

export type CatalogKind = "region" | "image" | "sku";

export interface CatalogItem {
  code: string;
  displayName: string;
  /** Only meaningful for kind "sku" — null for regions/images. */
  vcpus: number | null;
  memoryGb: number | null;
  /** Meaningful for kind "sku" (what it runs on) and "image" (what it
   * requires) — null for regions. */
  architecture: string | null;
}

export const providerCatalogKeys = {
  all: ["provider-catalog"] as const,
  list: (provider: "azure", kind: CatalogKind) =>
    [...providerCatalogKeys.all, provider, kind] as const,
};

export function useProviderCatalog(provider: "azure", kind: CatalogKind) {
  return useQuery({
    queryKey: providerCatalogKeys.list(provider, kind),
    queryFn: () =>
      apiGet<{ items: CatalogItem[] }>(`/api/v1/organisation/catalog/${provider}/${kind}`).then(
        (res) => res.items,
      ),
  });
}

export function useSyncAzureRegions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ items: CatalogItem[] }>("/api/v1/organisation/catalog/azure/regions/sync", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerCatalogKeys.list("azure", "region") });
      toast.success("Synced regions from Azure");
    },
    onError: (error) => {
      toast.error("Couldn't sync regions from Azure", { description: error.message });
    },
  });
}

export function useSyncAzureSizes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ items: CatalogItem[] }>("/api/v1/organisation/catalog/azure/sizes/sync", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerCatalogKeys.list("azure", "sku") });
      toast.success("Synced sizes from Azure");
    },
    onError: (error) => {
      toast.error("Couldn't sync sizes from Azure", { description: error.message });
    },
  });
}
