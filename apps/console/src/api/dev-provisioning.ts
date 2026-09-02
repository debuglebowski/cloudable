import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPatch } from "@/lib/api-client";

/**
 * Dev-only control for which `ProvisioningService` the running control-plane
 * dispatches to (fake/docker/azure) — wired to `apps/control-plane/src/http/
 * routes/dev-provisioning.ts`. Not a real org setting: no inheritance, no
 * audit event, one value for the whole control-plane process. The page that
 * renders this must gate it behind `import.meta.env.DEV` itself — the real
 * enforcement is server-side (`overridable` below, checked again on every
 * PATCH), this is just the console never offering the control in a
 * production build.
 */
export type ProvisioningAdapter = "fake" | "docker" | "azure";

export interface DevProvisioningAdapterState {
  current: ProvisioningAdapter;
  bootDefault: ProvisioningAdapter;
  /** `false` when this control-plane booted with `PROVISIONING_ADAPTER=azure` — permanent for the process's life. */
  overridable: boolean;
}

const devProvisioningKeys = {
  all: ["dev-provisioning-adapter"] as const,
};

export function useDevProvisioningAdapter() {
  return useQuery({
    queryKey: devProvisioningKeys.all,
    queryFn: () => apiGet<DevProvisioningAdapterState>("/api/v1/dev/provisioning-adapter"),
  });
}

export function useSetDevProvisioningAdapter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (adapter: ProvisioningAdapter) =>
      apiPatch<DevProvisioningAdapterState>("/api/v1/dev/provisioning-adapter", { adapter }),
    onSuccess: (data) => {
      queryClient.setQueryData(devProvisioningKeys.all, data);
      toast.success(`Provisioning adapter switched to ${data.current}`);
    },
    onError: (error) => {
      toast.error("Couldn't switch provisioning adapter", { description: error.message });
    },
  });
}
