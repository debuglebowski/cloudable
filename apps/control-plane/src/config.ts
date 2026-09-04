import { Context, Layer } from "effect";

/**
 * Control-plane configuration, read once from `process.env` with sane dev
 * defaults (see `.env.example` at the repo root).
 *
 * Kept as a plain synchronous object rather than routed through Effect's
 * `Config` module: some consumers (e.g. `auth.ts`, which constructs a
 * BetterAuth instance at module-load time, outside any Effect run) need a
 * value before an Effect runtime exists at all. The same values are also
 * exposed as an `AppConfigTag`/`AppConfigLive` Effect service below, for
 * anything that prefers to depend on it through the layer graph.
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly betterAuthSecret: string;
  readonly betterAuthUrl: string;
  /**
   * Azure AD's published JWKS, used to verify Azure managed-identity IMDS
   * tokens. Azure AD's signing keys are shared across
   * tenants, so the "common" discovery endpoint's key set verifies a token
   * for any tenant — configurable so tests can point it at a local mock
   * JWKS server instead.
   */
  readonly managedIdentityJwksUrl: string;
  /** Expected `aud` claim on an IMDS-issued managed-identity token. */
  readonly managedIdentityAudience: string;
  /**
   * This control plane's own OIDC issuer URL (see `docs/cloud-auth.md`).
   * Used both as the `issuer` field of the discovery document and as the
   * `iss` claim of every minted federation token. Must be the exact,
   * publicly reachable URL a customer's Azure federated identity
   * credential is configured to trust.
   */
  readonly federationIssuerUrl: string;
  /**
   * `aud` claim on minted federation tokens. Defaults to
   * `api://AzureADTokenExchange` — the fixed audience Entra ID expects for
   * OIDC-based workload identity federation (matches what GitHub Actions,
   * Terraform Cloud, etc. use for the same mechanism).
   */
  readonly federationAudience: string;
  /**
   * Origin of the console dev server (see `apps/console/vite.config.ts`),
   * allowed via CORS — the console and control-plane run on different
   * ports/origins in local dev, and every console page's `fetch` call would
   * otherwise be silently blocked by the browser with no server-side error
   * to point at (the response itself is fine; the browser just withholds
   * the body from JS when `Access-Control-Allow-Origin` is missing).
   */
  readonly consoleOrigin: string;
  /**
   * Where a Local Docker machine's agent reaches this control-plane.
   * Defaults to `host.docker.internal` — the container's own host, from
   * inside the container — not `localhost`, which inside a container means
   * the container itself.
   */
  readonly localDockerControlPlaneUrl: string;
  /**
   * Azure subscription `ProvisioningService.azure.ts` provisions real
   * machines into. Self-hosted mode only (docs/cloud-auth.md's "fully
   * managed mode uses a managed identity ... same provisioning-layer code
   * path") — `DefaultAzureCredential` supplies the actual credential
   * (Container App managed identity in production, `az login` locally),
   * this is only the target subscription. Required for a machine to
   * actually provision on `provider: "azure"` (and for the org-level Azure
   * region catalog to sync) — the adapter fails closed at construction if
   * unset rather than guessing a subscription; `null` is also what makes
   * `GET /api/v1/provisioning/capabilities` report Azure unavailable on
   * this deployment.
   */
  readonly azureSubscriptionId: string | null;
  /**
   * The single dedicated resource group (`infra/terraform/control-plane`'s
   * `machines_resource_group_name` output) machines are provisioned into.
   * Matches the BYOC module's naming convention.
   */
  readonly azureMachinesResourceGroup: string;
  /**
   * Full ARM resource id of the pre-created subnet
   * (`infra/terraform/control-plane`'s `machines_subnet_id` output) new
   * machines' NICs join. `ProvisioningService.azure.ts` never creates or
   * modifies the VNet/subnet/NSG itself — see that Terraform module's
   * comment on why the RBAC role grants join-only, not write, access.
   */
  readonly azureMachinesSubnetId: string | null;
  /**
   * Directory the compiled agent + tunnel-daemon binaries live in —
   * `GET /_internal/binaries/:target` (`http/routes/binaries.ts`) serves
   * them from here. Matches where `Dockerfile` copies them to in the
   * published image; irrelevant in local dev (the docker/fake adapters
   * don't need this route at all).
   */
  readonly agentBinariesDir: string;
}

const readConfig = (): AppConfig => {
  const port = Number(process.env["PORT"] ?? 4780);
  return {
    databaseUrl:
      process.env["DATABASE_URL"] ?? "postgres://cloudable:cloudable@localhost:5442/cloudable",
    port,
    betterAuthSecret: process.env["BETTER_AUTH_SECRET"] ?? "dev-only-change-me",
    betterAuthUrl: process.env["BETTER_AUTH_URL"] ?? "http://localhost:4780",
    managedIdentityJwksUrl:
      process.env["MANAGED_IDENTITY_JWKS_URL"] ??
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    managedIdentityAudience:
      process.env["MANAGED_IDENTITY_AUDIENCE"] ?? "https://management.azure.com/",
    federationIssuerUrl: process.env["FEDERATION_ISSUER_URL"] ?? `http://localhost:${port}`,
    federationAudience: process.env["FEDERATION_AUDIENCE"] ?? "api://AzureADTokenExchange",
    consoleOrigin: process.env["CONSOLE_ORIGIN"] ?? "http://localhost:5180",
    localDockerControlPlaneUrl:
      process.env["LOCAL_DOCKER_CONTROL_PLANE_URL"] ?? `http://host.docker.internal:${port}`,
    azureSubscriptionId: process.env["AZURE_SUBSCRIPTION_ID"] ?? null,
    azureMachinesResourceGroup:
      process.env["AZURE_MACHINES_RESOURCE_GROUP"] ?? "rg-cloudable-managed",
    azureMachinesSubnetId: process.env["AZURE_MACHINES_SUBNET_ID"] ?? null,
    agentBinariesDir: process.env["AGENT_BINARIES_DIR"] ?? "/app/binaries",
  };
};

/** Plain, synchronous config — safe to import from anywhere, Effect or not. */
export const config: AppConfig = readConfig();

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

export const AppConfigLive = Layer.succeed(AppConfigTag, config);
