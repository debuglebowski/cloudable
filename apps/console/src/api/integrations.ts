import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api-client";

/**
 * Integrations — wired to the real `apps/control-plane/src/http/routes/
 * integrations.ts`, a generic CRUD layer over the real `integrations`
 * table (id/kind/identifier/connectedAt/removedAt/config) added
 * specifically for this page. No unit in the original batch built it: the
 * federation backend (unit 11) mints tokens against an *already-connected*
 * cloud integration, and the secrets backend (unit 13) injects from an
 * *already-connected* secret store — neither one is "store the connection
 * pointer itself", which is all this page ever needed.
 */

export type IntegrationKind = "idp" | "cloud" | "secret_store";

const INTEGRATION_KIND_LABEL: Record<IntegrationKind, string> = {
  idp: "Identity provider",
  cloud: "Cloud provider",
  secret_store: "Secret store",
};

/** Non-secret SCIM/OIDC pointer. Cloudable never stores an IdP client secret. */
export interface IdpConfig {
  provider: string;
  metadataUrl: string;
}

/** Workload identity federation identifiers only. Never a client secret. */
export interface CloudConfig {
  tenantId: string;
  applicationId: string;
  subscriptionId: string;
}

/** A pointer at the customer's own store. Never a secret value. */
export interface SecretStoreConfig {
  provider: "azure_key_vault" | "1password";
  vaultUrl: string;
}

interface IntegrationBase {
  id: string;
  orgId: string;
  identifier: string;
  connectedAt: string;
  removedAt: string | null;
}

export type Integration =
  | (IntegrationBase & { kind: "idp"; config: IdpConfig })
  | (IntegrationBase & { kind: "cloud"; config: CloudConfig })
  | (IntegrationBase & { kind: "secret_store"; config: SecretStoreConfig });

export type ConnectIntegrationInput =
  | { kind: "idp"; identifier: string; config: IdpConfig }
  | { kind: "cloud"; identifier: string; config: CloudConfig }
  | { kind: "secret_store"; identifier: string; config: SecretStoreConfig };

export const integrationKeys = {
  all: ["integrations"] as const,
  list: () => [...integrationKeys.all, "list"] as const,
};

export function useIntegrations() {
  return useQuery({
    queryKey: integrationKeys.list(),
    queryFn: async () => {
      const res = await apiGet<{ items: Integration[] }>("/api/v1/integrations");
      return res.items;
    },
  });
}

/** Picks the connected integration of a given kind out of a list, narrowing its config type. */
export function pickConnected<K extends IntegrationKind>(
  integrations: Integration[] | undefined,
  kind: K,
): Extract<Integration, { kind: K }> | undefined {
  return integrations?.find(
    (integration): integration is Extract<Integration, { kind: K }> => integration.kind === kind,
  );
}

export function useConnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConnectIntegrationInput) =>
      apiPost<Integration>("/api/v1/integrations", {
        kind: input.kind,
        identifier: input.identifier,
        config: input.config,
      }),
    onSuccess: (connected) => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      toast.success(`${INTEGRATION_KIND_LABEL[connected.kind]} connected`);
    },
    onError: (error, input) => {
      toast.error(`Couldn't connect ${INTEGRATION_KIND_LABEL[input.kind].toLowerCase()}`, {
        description: error.message,
      });
    },
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (integration: Integration) => {
      await apiPost(`/api/v1/integrations/${integration.id}/disconnect`);
    },
    onSuccess: (_result, integration) => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      toast.success(`${INTEGRATION_KIND_LABEL[integration.kind]} disconnected`);
    },
    onError: (error, integration) => {
      toast.error(`Couldn't disconnect ${INTEGRATION_KIND_LABEL[integration.kind].toLowerCase()}`, {
        description: error.message,
      });
    },
  });
}
