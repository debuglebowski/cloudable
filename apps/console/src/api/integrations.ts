import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * MOCK DATA LAYER — no backend yet.
 *
 * This unit forks from bootstrap-only `main`. The cloud-federation backend
 * (unit 11) and secrets-injection backend (unit 13) are still open,
 * unmerged PRs at fork time, so `apps/control-plane` exposes no HTTP routes
 * for integrations. Everything below is an in-memory stand-in, shaped to
 * match `packages/schema/src/tables/integration.ts` and the
 * `org.integration_connected` / `org.integration_removed` event payloads in
 * `packages/events/src/domains/org.ts`, so swapping in real `apiGet`/`apiPost`
 * calls later only means replacing the `queryFn`/`mutationFn` bodies below —
 * the hook shapes and query keys should not need to change.
 */

export type IntegrationKind = "idp" | "cloud" | "secret_store";

/** Non-secret SCIM/OIDC pointer. Cloudable never stores an IdP client secret. */
export interface IdpConfig {
  provider: string;
  metadataUrl: string;
}

/** Workload identity federation identifiers only — see docs/spec.md §10. Never a client secret. */
export interface CloudConfig {
  tenantId: string;
  applicationId: string;
  subscriptionId: string;
}

/** A pointer at the customer's own store. Never a secret value — see docs/spec.md §12. */
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

/** Simulated mock-network latency, shared with src/api/organisation.ts's mock layer. */
export function delay<T>(value: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function makeId(): string {
  return crypto.randomUUID();
}

let mockIntegrations: Integration[] = [
  {
    id: makeId(),
    orgId: "org-1",
    kind: "idp",
    identifier: "Entra ID — normain.com",
    connectedAt: "2026-06-02T09:12:00Z",
    removedAt: null,
    config: {
      provider: "Entra ID",
      metadataUrl:
        "https://login.microsoftonline.com/normain.onmicrosoft.com/federationmetadata.xml",
    },
  },
  {
    id: makeId(),
    orgId: "org-1",
    kind: "cloud",
    identifier: "Azure — subscription 4f21a9…",
    connectedAt: "2026-06-02T09:20:00Z",
    removedAt: null,
    config: {
      tenantId: "8f14e3a1-2b6d-4c7f-9a01-1e6c5d9b7f30",
      applicationId: "3c9b1d5e-7a44-4f0a-8c2b-6e1d4a9f0c12",
      subscriptionId: "4f21a9c8-0d3e-4b5a-9f1c-2a7e8d6b0f45",
    },
  },
  // secret_store intentionally left unconnected so the connect form is visible by default.
];

export const integrationKeys = {
  all: ["integrations"] as const,
  list: () => [...integrationKeys.all, "list"] as const,
};

export function useIntegrations() {
  return useQuery({
    queryKey: integrationKeys.list(),
    queryFn: () => delay(mockIntegrations.filter((integration) => integration.removedAt == null)),
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
    mutationFn: (input: ConnectIntegrationInput) => {
      const connected = {
        id: makeId(),
        orgId: "org-1",
        connectedAt: new Date().toISOString(),
        removedAt: null,
        ...input,
      } as Integration;
      mockIntegrations = [
        ...mockIntegrations.filter(
          (integration) => integration.kind !== input.kind || integration.removedAt != null,
        ),
        connected,
      ];
      return delay(connected);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.all }),
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      mockIntegrations = mockIntegrations.map((integration) =>
        integration.id === id
          ? { ...integration, removedAt: new Date().toISOString() }
          : integration,
      );
      return delay(undefined);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.all }),
  });
}
