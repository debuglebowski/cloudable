import { Boxes, Container, Lock, TestTube2, UserCog } from "lucide-react";

import {
  pickConnected,
  pickConnectedProvider,
  useDisconnectIntegration,
  useIntegrations,
} from "@/api/integrations";
import type { Integration } from "@/api/integrations";
import { useProvisioningCapabilities } from "@/api/provisioning-capabilities";
import { PageLoader } from "@/components/page-loader";

import { CatalogChecklist } from "./catalog-checklist";
import {
  CloudEnableButton,
  IdpConnectDialog,
  SECRET_STORE_PROVIDER_LABEL,
  SecretStoreConnectDialog,
} from "./connect-dialogs";
import { IntegrationCard } from "./integration-card";

/** A category header: bold and full-size (not a quiet muted-foreground
 * label like the nav rail's group headers — this is page content, not
 * chrome) — so "Identity provider" / "Cloud providers" / "Secret store"
 * stand out on their own, without a divider line, relying on generous
 * vertical spacing (see the `gap-10` wrapper below) to separate sections. */
function CategorySection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function IntegrationsPage() {
  const { data: integrations, isLoading } = useIntegrations();
  const { data: capabilities } = useProvisioningCapabilities();
  const disconnect = useDisconnectIntegration();

  const idp = pickConnected(integrations, "idp");
  const secretStore = pickConnected(integrations, "secret_store");
  const azure = pickConnectedProvider(integrations, "azure");
  const docker = pickConnectedProvider(integrations, "docker");
  const fake = pickConnectedProvider(integrations, "fake");

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
          No cloud credential is ever stored, and Cloudable is the secrets injector, never the
          vault. Enabling a cloud provider is a policy decision, not a connection — this
          deployment's own credential (or Docker/Fake's lack of one) is ambient, never entered here.
        </p>
      </div>

      {isLoading ? (
        <PageLoader />
      ) : (
        <div className="flex flex-col gap-10">
          <CategorySection title="Identity provider">
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
            </div>
          </CategorySection>

          <CategorySection
            title="Cloud providers"
            description="Every enabled provider becomes a choice on the Add machine dialog — a machine picks exactly one, at creation, from whatever this org has enabled here."
          >
            <div className="grid gap-4 md:grid-cols-3">
              <IntegrationCard
                title="Azure"
                icon={Boxes}
                description={
                  capabilities && !capabilities.azure.available
                    ? "Not available on this deployment — AZURE_SUBSCRIPTION_ID isn't configured."
                    : "This deployment's own managed identity. One subscription for the whole deployment, not per-org federation."
                }
                integration={azure}
                connectForm={
                  <CloudEnableButton
                    provider="azure"
                    disabled={capabilities ? !capabilities.azure.available : true}
                  />
                }
                onDisconnect={handleDisconnect}
              >
                {() => (
                  <div className="flex flex-col gap-2">
                    {capabilities?.azure.subscriptionId && (
                      <span className="break-all font-mono text-xs text-muted-foreground">
                        Subscription {capabilities.azure.subscriptionId}
                      </span>
                    )}
                    <CatalogChecklist title="Regions" kind="region" showSync />
                    <CatalogChecklist title="Images" kind="image" />
                  </div>
                )}
              </IntegrationCard>

              <IntegrationCard
                title="Docker"
                icon={Container}
                description="Real local containers running the real agent binary — for self-hosting without a cloud subscription."
                integration={docker}
                connectForm={<CloudEnableButton provider="docker" />}
                onDisconnect={handleDisconnect}
              >
                {() => <p className="text-muted-foreground">No configuration — regionless.</p>}
              </IntegrationCard>

              <IntegrationCard
                title="Fake"
                icon={TestTube2}
                description="In-memory, no real infra — for trying Cloudable out before connecting a real provider."
                integration={fake}
                connectForm={<CloudEnableButton provider="fake" />}
                onDisconnect={handleDisconnect}
              >
                {() => <p className="text-muted-foreground">No configuration — regionless.</p>}
              </IntegrationCard>
            </div>
          </CategorySection>

          <CategorySection title="Secret store">
            <div className="grid gap-4 md:grid-cols-3">
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
          </CategorySection>
        </div>
      )}
    </div>
  );
}
