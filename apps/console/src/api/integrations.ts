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
/** Which cloud backend a `kind: "cloud"` row is for — see this file's header
 * comment on why cloud is multi-slot (one row per provider) while
 * idp/secret_store stay single-slot per org. */
export type CloudProvider = "azure" | "docker" | "fake";

const INTEGRATION_KIND_LABEL: Record<IntegrationKind, string> = {
  idp: "Microsoft Entra ID",
  cloud: "Cloud provider",
  secret_store: "Secret store",
};

/** Non-secret SCIM/OIDC pointer. Cloudable never stores an IdP client secret.
 * `provider` is a literal (not a free string) since Entra ID is the only
 * supported IdP — matches `CloudConfig`/`SecretStoreConfig`'s discriminated
 * shape, so a second IdP later is an added union member, not a rewrite. */
export interface IdpConfig {
  provider: "entra_id";
  metadataUrl: string;
}

/**
 * Cloud provider config, discriminated by `provider`. Empty for all three —
 * this deployment's Azure credential is ambient (its own managed identity,
 * one subscription for the whole deployment, see `GET /api/v1/
 * provisioning/capabilities`), not something entered per org, so enabling
 * any of the three is a fieldless "Enable," not a connection form.
 * (Workload-identity BYOC federation, once a real feature, would be the one
 * to reintroduce a tenant/application-id entry form here — this isn't it.)
 */
export type CloudConfig = { provider: CloudProvider };

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
  | (IntegrationBase & { kind: "idp"; provider: null; config: IdpConfig })
  | (IntegrationBase & { kind: "cloud"; provider: CloudProvider; config: CloudConfig })
  | (IntegrationBase & { kind: "secret_store"; provider: null; config: SecretStoreConfig });

export type ConnectIntegrationInput =
  | { kind: "idp"; identifier: string; config: IdpConfig }
  | { kind: "cloud"; provider: CloudProvider; identifier: string; config: CloudConfig }
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

/** Picks the connected integration of a given kind out of a list, narrowing its config type.
 * For `kind: "cloud"`, several rows can be connected at once (one per provider) — this
 * returns whichever is found first, which is only meaningful for the single-slot
 * kinds (idp/secret_store). Use `pickConnectedProvider` for cloud. */
export function pickConnected<K extends IntegrationKind>(
  integrations: Integration[] | undefined,
  kind: K,
): Extract<Integration, { kind: K }> | undefined {
  return integrations?.find(
    (integration): integration is Extract<Integration, { kind: K }> => integration.kind === kind,
  );
}

/** Picks the connected `kind: "cloud"` integration for one specific provider — cloud is
 * multi-slot (azure/docker/fake can all be connected at once), so this is the real
 * per-provider lookup the Integrations page's three cloud-provider cards use. */
export function pickConnectedProvider(
  integrations: Integration[] | undefined,
  provider: CloudProvider,
): Extract<Integration, { kind: "cloud" }> | undefined {
  return integrations?.find(
    (integration): integration is Extract<Integration, { kind: "cloud" }> =>
      integration.kind === "cloud" && integration.provider === provider,
  );
}

export function useConnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConnectIntegrationInput) =>
      apiPost<Integration>("/api/v1/integrations", {
        kind: input.kind,
        ...(input.kind === "cloud" ? { provider: input.provider } : {}),
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
