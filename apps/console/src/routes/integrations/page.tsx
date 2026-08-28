import { pickConnected, useDisconnectIntegration, useIntegrations } from "@/api/integrations";
import type { Integration } from "@/api/integrations";

import {
  CloudConnectDialog,
  IdpConnectDialog,
  SECRET_STORE_PROVIDER_LABEL,
  SecretStoreConnectDialog,
} from "./connect-dialogs";
import { IntegrationCard } from "./integration-card";

export function IntegrationsPage() {
  const { data: integrations, isLoading } = useIntegrations();
  const disconnect = useDisconnectIntegration();

  const idp = pickConnected(integrations, "idp");
  const cloud = pickConnected(integrations, "cloud");
  const secretStore = pickConnected(integrations, "secret_store");

  function handleDisconnect(integration: Integration) {
    const confirmed = window.confirm(
      "Disconnect this integration? Cloudable stops using it immediately — nothing is deleted on the other side.",
    );
    if (confirmed) {
      disconnect.mutate(integration.id);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Federation only — no cloud credential is ever stored (invariant 1), and Cloudable is the
          secrets injector, never the vault (invariant 8). Every form below takes non-secret
          pointers only.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <IntegrationCard
            title="Identity provider"
            description="SCIM 2.0 + OIDC against any IdP. Optional — without one, People stays Cloudable's fully editable system of record (docs/spec.md §3)."
            integration={idp}
            connectForm={<IdpConnectDialog />}
            onDisconnect={handleDisconnect}
          >
            {(integration) => (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{integration.identifier}</span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {integration.config.metadataUrl}
                </span>
              </div>
            )}
          </IntegrationCard>

          <IntegrationCard
            title="Cloud provider"
            description="Workload identity federation to Azure. Cloudable never receives or stores a client secret — only these three identifiers (docs/spec.md §10)."
            integration={cloud}
            connectForm={<CloudConnectDialog />}
            onDisconnect={handleDisconnect}
          >
            {(integration) => (
              <dl className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                <div className="flex justify-between gap-2">
                  <dt>Tenant</dt>
                  <dd className="truncate">{integration.config.tenantId}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Application</dt>
                  <dd className="truncate">{integration.config.applicationId}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Subscription</dt>
                  <dd className="truncate">{integration.config.subscriptionId}</dd>
                </div>
              </dl>
            )}
          </IntegrationCard>

          <IntegrationCard
            title="Secret store"
            description="Cloudable fetches and injects at runtime; it never stores a secret value (docs/spec.md §12). Point at your own vault."
            integration={secretStore}
            connectForm={<SecretStoreConnectDialog />}
            onDisconnect={handleDisconnect}
          >
            {(integration) => (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {SECRET_STORE_PROVIDER_LABEL[integration.config.provider]}
                </span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {integration.config.vaultUrl}
                </span>
              </div>
            )}
          </IntegrationCard>
        </div>
      )}
    </div>
  );
}
