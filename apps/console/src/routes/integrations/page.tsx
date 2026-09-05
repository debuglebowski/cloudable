import { Si1password, SiDocker } from "@icons-pack/react-simple-icons";
import { Drama } from "lucide-react";

import {
  pickConnected,
  pickConnectedProvider,
  useDisconnectIntegration,
  useIntegrations,
} from "@/api/integrations";
import type { Integration } from "@/api/integrations";
import { useProvisioningCapabilities } from "@/api/provisioning-capabilities";
import { PageLoader } from "@/components/page-loader";

import { AzureCatalogDialog } from "./catalog-checklist";
import {
  CloudEnableButton,
  IdpConnectDialog,
  SECRET_STORE_PROVIDER_LABEL,
  SecretStoreConnectDialog,
} from "./connect-dialogs";
import { IntegrationCard } from "./integration-card";

/** Self-hosted (public/logos/azure.svg — from github.com/gilbarbara/logos, CC0)
 * since Microsoft's mark isn't in @icons-pack/react-simple-icons. Used for both
 * Azure cards (cloud provider + Azure Key Vault secret store). Renders in its
 * own real colors already (a static multi-color SVG, not `currentColor`-tinted). */
function AzureLogo({ className }: { className?: string }) {
  return <img src="/logos/azure.svg" alt="Azure" className={className} />;
}

/** `@icons-pack/react-simple-icons` components default to `fill="currentColor"`
 * (so they'd render muted-gray inside `IntegrationCard`'s icon square, like a
 * lucide icon) — `color="default"` opts into each brand's real hex instead,
 * matching `AzureLogo`'s already-real-color treatment. */
function DockerLogo({ className }: { className?: string }) {
  return <SiDocker className={className} color="default" />;
}

function OnePasswordLogo({ className }: { className?: string }) {
  return <Si1password className={className} color="default" />;
}

/** Self-hosted (public/logos/microsoft.svg — from github.com/gilbarbara/logos, CC0).
 * The Identity provider integration is Microsoft Entra ID specifically (see
 * `docs/spec.md` §3) — no dedicated Entra mark exists in either icon source, so
 * this is the generic four-color Microsoft flag rather than `AzureLogo`, since
 * Entra isn't the Azure compute brand. */
function MicrosoftLogo({ className }: { className?: string }) {
  return <img src="/logos/microsoft.svg" alt="Microsoft" className={className} />;
}

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
  const azureKeyVault =
    secretStore?.config.provider === "azure_key_vault" ? secretStore : undefined;
  const onePassword = secretStore?.config.provider === "1password" ? secretStore : undefined;
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
                title="Microsoft Entra ID"
                icon={MicrosoftLogo}
                description="SCIM 2.0 + OIDC against your Entra tenant. Optional — without one, People stays Cloudable's fully editable system of record."
                integration={idp}
                connectForm={<IdpConnectDialog />}
                onDisconnect={handleDisconnect}
              >
                {(integration) => (
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {integration.config.metadataUrl}
                  </span>
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
                icon={AzureLogo}
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
                secondaryAction={<AzureCatalogDialog />}
              >
                {() =>
                  capabilities?.azure.subscriptionId ? (
                    <span className="break-all font-mono text-xs text-muted-foreground">
                      Subscription {capabilities.azure.subscriptionId}
                    </span>
                  ) : null
                }
              </IntegrationCard>

              <IntegrationCard
                title="Docker"
                icon={DockerLogo}
                description="Real local containers running the real agent binary — for self-hosting without a cloud subscription."
                integration={docker}
                connectForm={<CloudEnableButton provider="docker" />}
                onDisconnect={handleDisconnect}
              >
                {() => <p className="text-muted-foreground">No configuration — regionless.</p>}
              </IntegrationCard>

              <IntegrationCard
                title="Fake"
                icon={Drama}
                description="In-memory, no real infra — for trying Cloudable out before connecting a real provider."
                integration={fake}
                connectForm={<CloudEnableButton provider="fake" />}
                onDisconnect={handleDisconnect}
              >
                {() => <p className="text-muted-foreground">No configuration — regionless.</p>}
              </IntegrationCard>
            </div>
          </CategorySection>

          <CategorySection
            title="Secret store"
            description="Cloudable fetches and injects at runtime; it never stores a secret value. Only one can be connected at a time — connecting one replaces the other."
          >
            <div className="grid gap-4 md:grid-cols-3">
              <IntegrationCard
                title={SECRET_STORE_PROVIDER_LABEL.azure_key_vault}
                icon={AzureLogo}
                description="Point at your own vault by URL."
                integration={azureKeyVault}
                connectForm={
                  <SecretStoreConnectDialog
                    provider="azure_key_vault"
                    replacesLabel={
                      onePassword ? SECRET_STORE_PROVIDER_LABEL["1password"] : undefined
                    }
                  />
                }
                onDisconnect={handleDisconnect}
              >
                {(integration) => (
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {integration.config.vaultUrl}
                  </span>
                )}
              </IntegrationCard>

              <IntegrationCard
                title={SECRET_STORE_PROVIDER_LABEL["1password"]}
                icon={OnePasswordLogo}
                description="Point at your own vault by URL."
                integration={onePassword}
                connectForm={
                  <SecretStoreConnectDialog
                    provider="1password"
                    replacesLabel={
                      azureKeyVault ? SECRET_STORE_PROVIDER_LABEL.azure_key_vault : undefined
                    }
                  />
                }
                onDisconnect={handleDisconnect}
              >
                {(integration) => (
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {integration.config.vaultUrl}
                  </span>
                )}
              </IntegrationCard>
            </div>
          </CategorySection>
        </div>
      )}
    </div>
  );
}
