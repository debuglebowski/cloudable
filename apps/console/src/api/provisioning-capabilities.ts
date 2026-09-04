import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";

/**
 * What this *deployment* can technically run — not what an org has enabled
 * (that's `useIntegrations()`, `kind: "cloud"` rows). Azure is available iff
 * this control-plane booted with `AZURE_SUBSCRIPTION_ID` configured (see
 * `apps/control-plane/src/config.ts`); docker/fake always are. Drives
 * whether the Integrations page's "Enable" action for a cloud provider is
 * even offered.
 */
export interface ProvisioningCapabilities {
  azure: { available: boolean; subscriptionId: string | null; resourceGroup: string | null };
  docker: { available: boolean };
  fake: { available: boolean };
}

export function useProvisioningCapabilities() {
  return useQuery({
    queryKey: ["provisioning-capabilities"],
    queryFn: () => apiGet<ProvisioningCapabilities>("/api/v1/provisioning/capabilities"),
  });
}
