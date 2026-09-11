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
/** Trust anchors for the configured SAML identity provider — see `idpSamlConfig`. */
export interface IdpSamlConfig {
  /** The IdP's entity id, checked against the assertion's Issuer. */
  readonly entityId: string;
  /** HTTP-Redirect SSO endpoint: where an SP-initiated AuthnRequest goes. */
  readonly ssoUrl: string;
  /** Every advertised signing certificate, so a rotation window is a non-event. */
  readonly certs: readonly string[];
}

export interface AppConfig {
  readonly databaseUrl: string;
  /**
   * `entra` swaps `databaseUrl`'s password for a managed-identity access
   * token per connection (see `db/connect.ts`) — what a real deployment
   * runs, so no database password exists anywhere. `password` (the default)
   * uses the credential in `databaseUrl` itself: local dev, docker-compose
   * and tests. It is not a rollback for a real deployment — that server has
   * password auth disabled, so there is nothing to fall back to.
   */
  readonly databaseAuthMode: "password" | "entra";
  /**
   * Key Vault data-plane URI (e.g. `https://my-vault.vault.azure.net/`). When
   * set, the SSH CA and session-token keys live inside that vault and are
   * used through sign operations only — `null` falls back to
   * `Signer.local.ts`, which generates keys in-process (fine for local dev,
   * never for a real deployment: invariant #9, and the keys don't survive a
   * restart).
   */
  readonly keyVaultUri: string | null;
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
   * This control plane's own publicly reachable base URL. Used by
   * `ProvisioningService.azure.ts` to build the cloud-init script a new
   * Azure machine curls its agent/tunnel-daemon binaries from
   * (`GET /_internal/binaries/:target`) and as the `CONTROL_PLANE_URL` the
   * agent's systemd unit is given.
   */
  readonly controlPlaneBaseUrl: string;
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
   * Region `azureMachinesSubnetId` actually lives in — self-hosted mode has
   * exactly one usable region (that fixed subnet), so
   * `CloudCatalogService.ts`'s size sync filters `Microsoft.Compute/skus`
   * server-side to just this location: unfiltered, that ARM call took over
   * two minutes for a real subscription (tens of thousands of raw per-region
   * SKU records) and was slow enough to get the container killed mid-sync;
   * filtered to one region, a few seconds. `null` (e.g. self-hosted without
   * this var set yet, or Azure not configured at all) falls back to the
   * slow, unfiltered subscription-wide call.
   */
  readonly azureMachinesLocation: string | null;
  /**
   * Directory the compiled agent + tunnel-daemon binaries live in —
   * `GET /_internal/binaries/:target` (`http/routes/binaries.ts`) serves
   * them from here. Matches where `Dockerfile` copies them to in the
   * published image; irrelevant in local dev (the docker/fake adapters
   * don't need this route at all).
   */
  readonly agentBinariesDir: string;
  /**
   * Directory the console's built static assets (`vite build`'s output)
   * live in — `http/routes/console.ts`'s catch-all route serves them from
   * here. Matches where `Dockerfile` copies `apps/console/dist` to in the
   * published image; irrelevant in local dev, where console runs via its
   * own `vite` dev server (port 5180) instead of through this server.
   */
  readonly consoleDistDir: string;
  /**
   * Opt-in first-admin bootstrap (see `bootstrap-default-admin.ts`): if set,
   * and no BetterAuth account exists yet for this email, the control plane
   * creates an org + person + account for it at startup. There is otherwise
   * no self-service signup — BetterAuth rejects sign-up for any email
   * without a matching `people` row (`auth.ts`'s `databaseHooks`), and
   * adding one requires already being logged in. `null` (default) disables
   * this entirely. Pair with `defaultAdminPassword`.
   */
  readonly defaultAdminEmail: string | null;
  /** Password for `defaultAdminEmail`'s auto-created account. `null` disables the bootstrap. */
  readonly defaultAdminPassword: string | null;
  /**
   * SAML identity provider supplied by deployment config rather than
   * connected through the console's Integrations page. When set, this
   * deployment has exactly one IdP, it is declared in Terraform, and the
   * console shows the card as configured instead of editable — the same
   * "deployment config is authoritative" shape as `azureMachinesLocation`
   * (see `MachineService.ts`'s comment on why config beats admin-editable
   * state: the two drift, and physical reality wins).
   *
   * This is the metadata document's URL. It is not what BetterAuth
   * authenticates against — `idpMetadataXml` is — but it is what the console
   * displays, and keeping both means the UI can show where the XML came
   * from. `null` (default) restores the fully console-driven behaviour.
   */
  readonly idpMetadataUrl: string | null;
  /**
   * The IdP's trust anchors, as JSON: `{ entityId, ssoUrl, certs }`.
   *
   * Not the metadata document. `@better-auth/sso` accepts either the XML or
   * these fields directly (`SAMLIdentityProviderMetadata` is `metadata` OR
   * `entityID` plus certificate and endpoint), and the document itself is
   * unusable as configuration: Entra regenerates its EntityDescriptor ID and
   * enclosing Signature on every request, so passing the XML made the
   * Container App diff on every Terraform plan and restart on every apply.
   * The extracted fields are stable until the IdP rotates a signing
   * certificate, which is precisely when a change should be visible.
   *
   * Terraform does the fetching and extraction — `auth.ts` builds its
   * BetterAuth instance at module load, where there is nowhere to await, and
   * adding a fetch there would delay the HTTP listener, which `server.ts`
   * documents as a real Azure Container Apps startup-probe crash-loop.
   *
   * Ignored unless `idpMetadataUrl` is also set.
   */
  readonly idpSamlConfig: IdpSamlConfig | null;
  /** Display name for the configured IdP, shown on the console's Integrations card. */
  readonly idpDisplayName: string;
}

/**
 * Provider id for the config-declared SAML provider. A fixed constant, not a
 * generated id, and that is the point: `@better-auth/sso` routes its
 * assertion consumer endpoint per provider
 * (`/sso/saml2/sp/acs/:providerId`), so a stable id means the IdP's Reply URL
 * is knowable before anything has been connected. Terraform can then
 * configure the identity provider correctly in a single apply, instead of the
 * two-phase dance a generated row id forces.
 *
 * `@better-auth/sso` refuses to register any provider whose id collides with
 * a `defaultSSO` entry ("This providerId is reserved"), so this value is also
 * what stops the console overriding deployment config.
 */
export const CONFIGURED_IDP_PROVIDER_ID = "configured";

/**
 * Parses IDP_SAML_CONFIG, refusing anything incomplete rather than
 * half-configuring. A deployment that sets IDP_METADATA_URL has declared in
 * Terraform that it federates against an identity provider — quietly falling
 * back to console-driven setup would present an editable card that contradicts
 * its own infrastructure.
 */
const parseIdpSamlConfig = (raw: string | undefined): IdpSamlConfig | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`IDP_SAML_CONFIG is not valid JSON: ${String(cause)}`);
  }
  const value = parsed as Partial<IdpSamlConfig>;
  if (
    typeof value.entityId !== "string" ||
    typeof value.ssoUrl !== "string" ||
    !Array.isArray(value.certs) ||
    value.certs.length === 0
  ) {
    throw new Error(
      "IDP_SAML_CONFIG must be JSON with a non-empty entityId, ssoUrl and certs — Terraform builds it from the IdP's federation metadata.",
    );
  }
  return { entityId: value.entityId, ssoUrl: value.ssoUrl, certs: value.certs };
};

const readConfig = (): AppConfig => {
  const port = Number(process.env.PORT ?? 4780);
  const idpConfigured =
    (process.env.IDP_METADATA_URL ?? "").length > 0 &&
    (process.env.IDP_SAML_CONFIG ?? "").length > 0;
  return {
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable",
    // Anything other than the literal "entra" means password auth — an
    // unset or misspelled value falls back to the mode that works with a
    // plain connection string, rather than to one that needs Azure.
    databaseAuthMode: process.env.DATABASE_AUTH_MODE === "entra" ? "entra" : "password",
    keyVaultUri: process.env.KEY_VAULT_URI ?? null,
    port,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? "dev-only-change-me",
    betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:4780",
    managedIdentityJwksUrl:
      process.env.MANAGED_IDENTITY_JWKS_URL ??
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    managedIdentityAudience:
      process.env.MANAGED_IDENTITY_AUDIENCE ?? "https://management.azure.com/",
    controlPlaneBaseUrl: process.env.CONTROL_PLANE_BASE_URL ?? `http://localhost:${port}`,
    consoleOrigin: process.env.CONSOLE_ORIGIN ?? "http://localhost:5180",
    localDockerControlPlaneUrl:
      process.env.LOCAL_DOCKER_CONTROL_PLANE_URL ?? `http://host.docker.internal:${port}`,
    azureSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? null,
    azureMachinesResourceGroup: process.env.AZURE_MACHINES_RESOURCE_GROUP ?? "rg-cloudable-managed",
    azureMachinesSubnetId: process.env.AZURE_MACHINES_SUBNET_ID ?? null,
    azureMachinesLocation: process.env.AZURE_MACHINES_LOCATION ?? null,
    agentBinariesDir: process.env.AGENT_BINARIES_DIR ?? "/app/binaries",
    consoleDistDir: process.env.CONSOLE_DIST_DIR ?? "/app/console-dist",
    defaultAdminEmail: process.env.DEFAULT_ADMIN_EMAIL ?? null,
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD ?? null,
    // Both required together: a URL with no XML has nothing to authenticate
    // against, and XML with no URL leaves the console unable to say where it
    // came from. Either alone falls back to console-driven configuration
    // rather than half-enabling this path.
    idpMetadataUrl: idpConfigured ? (process.env.IDP_METADATA_URL ?? null) : null,
    idpSamlConfig: idpConfigured ? parseIdpSamlConfig(process.env.IDP_SAML_CONFIG) : null,
    idpDisplayName: process.env.IDP_DISPLAY_NAME ?? "Microsoft Entra ID",
  };
};

/** Plain, synchronous config — safe to import from anywhere, Effect or not. */
export const config: AppConfig = readConfig();

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

export const AppConfigLive = Layer.succeed(AppConfigTag, config);
