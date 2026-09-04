import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPatch, apiPost } from "@/lib/api-client";

/**
 * Org-curated region/image catalog for machine creation — see
 * `apps/control-plane/src/domain/organisation/catalog.ts`. Azure only today
 * (docker/fake are regionless and freeform-image, per `PROVIDER_CAPABILITIES`
 * in `add-machine-dialog.tsx`), but the path is provider-generic.
 */

export type CatalogKind = "region" | "image";

export interface CatalogItem {
  code: string;
  displayName: string;
  enabled: boolean;
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

export function useToggleCatalogEntry(provider: "azure", kind: CatalogKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entry: CatalogItem) =>
      apiPatch<{ items: CatalogItem[] }>(`/api/v1/organisation/catalog/${provider}/${kind}`, {
        code: entry.code,
        displayName: entry.displayName,
        enabled: !entry.enabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerCatalogKeys.list(provider, kind) });
    },
    onError: (error) => {
      toast.error(`Couldn't update the ${kind} catalog`, { description: error.message });
    },
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
