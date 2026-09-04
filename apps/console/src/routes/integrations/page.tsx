import { Lock, Network, UserCog } from "lucide-react";

import { pickConnected, useDisconnectIntegration, useIntegrations } from "@/api/integrations";
import type { Integration } from "@/api/integrations";
import { PageLoader } from "@/components/page-loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

  // Confirmation now lives in IntegrationCard itself (an AlertDialog behind the
  // Disconnect button) — this just forwards the already-confirmed mutation.
  function handleDisconnect(integration: Integration) {
    disconnect.mutate(integration);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Federation only — no cloud credential is ever stored, and Cloudable is the secrets
          injector, never the vault. Every form below takes non-secret pointers only.
        </p>
      </div>

      {isLoading ? (
        <PageLoader />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <IntegrationCard
            title="Identity provider"
            icon={UserCog}
            description="SCIM 2.0 + OIDC against any IdP. Optional — without one, People stays Cloudable's fully editable system of record."
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
            icon={Network}
            description="Workload identity federation to Azure. Cloudable never receives or stores a client secret — only these three identifiers."
            integration={cloud}
            connectForm={<CloudConnectDialog />}
            onDisconnect={handleDisconnect}
          >
            {(integration) => (
              <dl className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                <IdentifierRow label="Tenant" value={integration.config.tenantId} />
                <IdentifierRow label="Application" value={integration.config.applicationId} />
                <IdentifierRow label="Subscription" value={integration.config.subscriptionId} />
              </dl>
            )}
          </IntegrationCard>

          <IntegrationCard
            title="Secret store"
            icon={Lock}
            description="Cloudable fetches and injects at runtime; it never stores a secret value. Point at your own vault."
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

/** A truncated identifier that's still fully readable on hover — these are the exact three values a customer's security team would need to verify the federation is scoped correctly, so silently clipping one with no way to see the rest isn't acceptable here. */
function IdentifierRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <Tooltip>
        <TooltipTrigger asChild>
          <dd className="truncate">{value}</dd>
        </TooltipTrigger>
        <TooltipContent className="font-mono">{value}</TooltipContent>
      </Tooltip>
    </div>
  );
}
