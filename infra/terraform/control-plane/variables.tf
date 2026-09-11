variable "resource_group_name" {
  description = "Name of the Azure resource group to create for the control plane. This module owns the whole group — it creates it, it does not adopt an existing one."
  type        = string
  default     = "cloudable-control-plane"
}

variable "location" {
  description = "Azure region for every resource this module creates (e.g. \"westeurope\", \"eastus\")."
  type        = string
  default     = "westeurope"
}

variable "name_prefix" {
  description = "Short prefix used to derive resource names (Container Apps environment, Postgres server, etc). Keep it short and lowercase-alnum-hyphen; Postgres server names must be globally unique so a random suffix is appended automatically."
  type        = string
  default     = "cloudable"
}

variable "control_plane_image" {
  description = "Container image reference for the control plane, without tag (e.g. \"ghcr.io/debuglebowski/cloudable/control-plane\", the path .github/workflows/rebuild-base-image.yml actually publishes to: ghcr.io/<github.repository>/control-plane). Pair with control_plane_image_tag."
  type        = string
  default     = "ghcr.io/debuglebowski/cloudable/control-plane"
}

variable "control_plane_image_tag" {
  description = <<-EOT
    Tag to deploy. Defaults to "main", the tag rebuild-base-image.yml moves on
    every push to main — "latest" is never pushed by that workflow, so it is
    not a usable default here.

    Cloudable's own production deploys (`cloudable-deploy`, a separate private
    repo per docs/spec.md §26) pin by image *digest* rather than tag, because a
    tag can be repointed upstream and "what is running right now" needs to stay
    answerable. That pinning discipline is out of scope for this self-host
    module — a self-hoster is expected to move to a pinned digest themselves
    once they have a release process, by setting control_plane_image to
    "<repo>@sha256:<digest>" (or "<repo>@sha-<commit>") and leaving this tag
    variable unused.
  EOT
  type        = string
  default     = "main"
}

variable "control_plane_image_registry_server" {
  description = "Registry hostname the control-plane image is pulled from. Only used when control_plane_image_registry_password is set — a public image (or one on a registry the Container Apps environment can already reach, e.g. via managed identity) needs no registry credential at all."
  type        = string
  default     = "ghcr.io"
}

variable "control_plane_image_registry_username" {
  description = "Registry username for pulling control_plane_image, if it's private. For GHCR this is any GitHub username with read:packages on the image (a PAT is passed as the password)."
  type        = string
  default     = ""
}

variable "control_plane_image_registry_password" {
  description = "Registry password/PAT for pulling control_plane_image, if it's private (e.g. a GitHub PAT with read:packages scope for ghcr.io/debuglebowski/cloudable/control-plane, which is private by default). Leave empty for a public image. Marked sensitive; supply via *.tfvars, -var, or TF_VAR_control_plane_image_registry_password — never commit a real value."
  type        = string
  sensitive   = true
  default     = ""
}

variable "container_cpu" {
  description = "vCPU allocated to the control plane container app (Container Apps billing unit, e.g. 0.5, 1.0)."
  type        = number
  default     = 0.5
}

variable "container_memory" {
  description = "Memory allocated to the control plane container app (e.g. \"1Gi\")."
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Minimum Container App replica count. 1 keeps the control plane always warm; a self-hoster with no traffic overnight could set this to 0."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum Container App replica count."
  type        = number
  default     = 3
}

variable "postgres_sku_name" {
  description = "Azure Database for PostgreSQL Flexible Server SKU (e.g. \"B_Standard_B1ms\" for the smallest burstable tier suitable for a self-host trial)."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "16"
}

variable "postgres_storage_mb" {
  description = "Postgres Flexible Server storage size in MB."
  type        = number
  default     = 32768
}

variable "postgres_admin_username" {
  description = "Administrator login for the Postgres Flexible Server."
  type        = string
  default     = "cloudable"
}

variable "postgres_admin_password" {
  description = "Administrator password for the Postgres Flexible Server. Marked sensitive; supply via a .tfvars file that is not committed, or via TF_VAR_postgres_admin_password. Not needed — and not used — when enable_postgres_entra_auth is set, since that disables password authentication entirely and no admin password exists."
  type        = string
  sensitive   = true
  default     = null
}

variable "postgres_database_name" {
  description = "Name of the application database created on the Postgres server."
  type        = string
  default     = "cloudable"
}

variable "better_auth_secret" {
  description = "Secret used by BetterAuth to sign sessions (BETTER_AUTH_SECRET). Generate a random 32+ byte value, e.g. `openssl rand -base64 32`. Marked sensitive. Required UNLESS enable_key_vault is set, in which case leave it null and put the value in the vault as `better-auth-secret` instead — passing it here would write it into Terraform state, which is the thing the Key Vault path exists to avoid."
  type        = string
  sensitive   = true
  default     = null
}

variable "port" {
  description = "Port the control plane HTTP server listens on inside the container (PORT env var)."
  type        = number
  default     = 3000
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default = {
    project = "cloudable"
    mode    = "self-hosted"
  }
}

variable "enable_self_managed_machines" {
  description = "Whether to provision the network shell (resource group, VNet, subnet, NSG) and RBAC role that let this control plane's own managed identity provision real Azure VMs in this same tenant (self-hosted mode: no federation — see docs/cloud-auth.md, ProvisioningService.azure.ts). Set false to deploy the control plane without machine-provisioning capability."
  type        = bool
  default     = true
}

variable "machines_resource_group_name" {
  description = "Name of the single, dedicated resource group machines are provisioned into. Only used when enable_self_managed_machines is true."
  type        = string
  default     = "rg-cloudable-managed"
}

variable "create_resource_group" {
  description = "Whether this module creates resource_group_name itself (default), or adopts an existing, empty one you created yourself. Adopting matters when a deploying identity's own permissions are scoped to specific, already-existing resource groups: Azure has no way to scope 'permission to create a not-yet-existing resource group' any narrower than the whole subscription, so creating the resource group ahead of time is the only way to keep that identity's grant confined to just this one resource group."
  type        = bool
  default     = true
}

variable "create_machines_resource_group" {
  description = "Same as create_resource_group, for machines_resource_group_name. Only relevant when enable_self_managed_machines is true."
  type        = bool
  default     = true
}

variable "deploying_identity_principal_id" {
  description = "Object ID (not the application/client ID) of the identity running terraform plan/apply against this module, if it's a scoped-down deploying identity (e.g. a CI/CD OIDC service principal) rather than a subscription Owner/Contributor. Relevant to two features. (1) enable_self_managed_machines creates azurerm_role_assignment.catalog_reader at subscription scope: refreshing that resource on every plan/apply requires Microsoft.Authorization/roleAssignments/read at that same scope, which a narrowly-scoped deploying identity doesn't have by default — without it, terraform plan computes the right diff but then 403s trying to read the resource back. (2) enable_key_vault grants this identity 'Key Vault Crypto Officer' on the vault, so it can create the signing keys, and 'Key Vault Reader' so the key_vault_secrets_seeded check can list secret NAMES — reader is metadata-only and cannot read a secret value. Leave null (default) when the deploying identity already has broader access (e.g. subscription Owner/Contributor), or when neither feature is enabled. Setting this creates only narrow role assignments granting exactly those permissions, nothing else — and as with catalog_reader, the very first apply that creates each one needs an identity that already has Microsoft.Authorization/roleAssignments/write at the relevant scope (e.g. a human's own elevated login), since the deploying identity being granted access can't yet grant itself that access."
  type        = string
  default     = null
}

variable "custom_domain" {
  description = "Real public hostname this deployment is reached at (e.g. \"cloudable.example.com\"), if you've bound one yourself. Leave null (default) to use the auto-generated Azure Container Apps FQDN. This module does NOT bind the domain itself or touch any DNS — see README.md's custom-domain recipe for that, since it varies by DNS provider and needs azurerm v4 (this module targets v3+ generically). Setting this only changes what BETTER_AUTH_URL/CONTROL_PLANE_BASE_URL and the control_plane_url output say the deployment's real address is — get the binding live *before* setting this, not after, or auth/CORS will point at a hostname nothing serves yet."
  type        = string
  default     = null
}

variable "default_admin_email" {
  description = "Email for a self-hosted deployment's first admin account, auto-created at control-plane startup if no account exists for it yet (apps/control-plane/src/bootstrap-default-admin.ts). There is otherwise no self-service signup: BetterAuth rejects sign-up for any email without a matching `people` row, and adding one requires already being logged in — so without this, bootstrapping a first login takes manual SQL plus a direct BetterAuth API call. Leave null (default) to skip. Pair with default_admin_password; once you've logged in and changed your password, both can be unset — the bootstrap only ever acts once, the first time no account exists for this email."
  type        = string
  default     = null
}

variable "default_admin_password" {
  description = "Password for default_admin_email's auto-created account. Sensitive; supply via *.tfvars, -var, or TF_VAR_default_admin_password — never commit a real value. Only takes effect once, the first time no BetterAuth account exists for default_admin_email; a value left here after that point sits unused."
  type        = string
  sensitive   = true
  default     = null
}

variable "alert_action_group_id" {
  description = <<-EOT
    Azure Monitor Action Group resource ID to notify for the Postgres health
    alerts below (CPU/memory/disk-IOPS/storage). Leave null (default) to skip
    creating them entirely — most self-hosters won't have a pre-existing
    action group, and this module doesn't create one itself (that's org-wide
    alerting infrastructure, out of scope for a single-app deploy template).
    Create one yourself (`azurerm_monitor_action_group` or the Azure Portal)
    and pass its `id` here to wire alerts up to it.
  EOT
  type        = string
  default     = null
}

variable "enable_flow_logs" {
  description = <<-EOT
    Opt-in: enable Azure VNet Flow Logs on the machines VNet and subnet
    (only meaningful when enable_self_managed_machines is also true).
    Records IP traffic flows through them — since the machines NSG's only
    rule is DenyAllInbound, this produces auditable evidence that no inbound
    traffic actually reaches provisioned machines, not just that the rule
    exists on paper.

    Requires a regional Network Watcher to already exist (Azure enables one
    automatically per region unless explicitly disabled — true for the
    overwhelming majority of subscriptions) and creates its own storage
    account for the log data, with a 90-day retention (matching this
    project's own "retention is expiry" principle, not indefinite).

    The flow log resource itself must live in the Network Watcher's own
    resource group (an Azure requirement, not a Terraform choice — flow logs
    are technically child resources of the Network Watcher, not of the VNet
    they monitor), so the deploying identity needs write access there too,
    which this module does not grant.
  EOT
  type        = bool
  default     = false
}

variable "enable_private_networking" {
  description = <<-EOT
    Opt-in: put the Postgres Flexible Server behind VNet integration
    (delegated subnet + private DNS zone, public_network_access_enabled =
    false) instead of the default public-access + "allow Azure services"
    firewall rule, and give the Container Apps Environment an
    infrastructure_subnet_id in the same VNet so the control plane reaches
    Postgres over private IPs. Default false preserves today's public-access
    behavior unchanged for every existing self-hoster.

    WARNING: flipping this on an ALREADY-DEPLOYED instance forces recreation
    of both the Postgres server (delegated_subnet_id is ForceNew) and the
    Container Apps Environment (infrastructure_subnet_id is ForceNew, which
    cascades to recreating the Container App itself, including its managed
    identity and every role assignment bound to it) — this destroys the live
    database. See README.md's private-networking section before doing this
    against a real deployment; it's safe to set from the very first
    `terraform apply` of a brand-new deployment.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Key Vault-backed secrets (opt-in)
# ---------------------------------------------------------------------------

variable "enable_key_vault" {
  description = <<-EOT
    Opt-in master switch for the Key Vault path (supply key_vault_id and
    key_vault_uri alongside it).

    Separate from key_vault_id rather than derived from it because Terraform
    requires `count`/`for_each` to be resolvable at PLAN time: a caller
    naturally passes `key_vault_id = azurerm_key_vault.x.id`, whose value is
    unknown until apply, and deriving the toggle from it makes every
    conditional resource here unplannable ("The count value depends on
    resource attributes that cannot be determined until apply"). A plain bool
    is always known.
  EOT
  type        = bool
  default     = false
}

variable "key_vault_id" {
  description = <<-EOT
    Resource id of an EXISTING Key Vault holding this deployment's
    signing secrets. Set it (together with key_vault_uri) and the Container
    App stops carrying secret VALUES entirely — it references Key Vault
    secrets by URI and resolves them at container start with a user-assigned
    managed identity this module creates and grants "Key Vault Secrets User"
    on this vault. Nothing sensitive then exists in Terraform state.

    The vault itself is deliberately NOT created here: soft-delete/purge
    protection, network rules and naming are org-wide decisions that vary,
    and a vault outliving this module is the point. Same posture as
    alert_action_group_id.

    Leave null (default) to keep today's behavior exactly: system-assigned
    identity, secrets passed as plain values from var.better_auth_secret and
    friends.

    The vault must contain these four secrets (create them out-of-band, e.g.
    `az keyvault secret set` — putting them there via Terraform would defeat
    the purpose by writing the values back into state):
      better-auth-secret, join-token-secret, agent-session-secret,
      cli-auth-code-secret
  EOT
  type        = string
  default     = null
}

variable "key_vault_uri" {
  description = <<-EOT
    Data-plane URI of the same vault as key_vault_id (e.g.
    "https://my-vault.vault.azure.net/"), used to build the secret
    references. Both are required together; azurerm exposes them as the
    vault's `id` and `vault_uri` attributes. Taken as an input rather than
    looked up so this module needs no read permission on the vault.
  EOT
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# Postgres Entra (Azure AD) authentication (opt-in)
# ---------------------------------------------------------------------------

variable "enable_postgres_entra_auth" {
  description = <<-EOT
    Opt-in: enable Entra authentication on the Postgres Flexible Server and
    point the control plane at it, so the app authenticates with a
    short-lived managed-identity token instead of a stored password
    (DATABASE_URL loses its password; the app fetches a token per connection
    — see apps/control-plane/src/db/connect.ts).

    Requires key_vault_id/key_vault_uri, since it depends on the same
    user-assigned identity those create.

    Password authentication is turned OFF at the same time, so no admin
    password exists on the server and postgres_admin_password is neither
    required nor stored in state. That was the last secret value Terraform
    still held.

    There is therefore no instant rollback. Flipping the app's
    DATABASE_AUTH_MODE back to "password" alone will not work, because the
    server has no password to authenticate against. Recovery means setting
    this to false, supplying a postgres_admin_password, and applying again.

    One manual step this module cannot do for you: an Entra admin on the
    server must create a database role for the identity. Connect to the
    `postgres` database (the pgaadauth extension is only installed there,
    not in your application database) and run
    `SELECT pgaadauth_create_principal('<identity name>', false, false)`,
    then grant it membership in postgres_admin_username so it inherits
    ownership of the existing tables — it runs migrations on boot, so
    GRANT CONNECT alone is not enough. Not superuser. Until the role
    exists the app is rejected at connect time and crashes on boot.

    Note that with enable_private_networking this SQL cannot be run from
    your own machine at all: the server has no public endpoint. See
    README.md.
  EOT
  type        = bool
  default     = false
}

variable "postgres_entra_administrators" {
  description = <<-EOT
    Entra principals made Postgres AD administrators, keyed by principal name
    (UPN for a user, display name for a group or service principal). Needed so
    a real person can log in and run the one-time role bootstrap described on
    enable_postgres_entra_auth — Terraform can't do that step itself.

    A map rather than a single principal because a deployment usually has more
    than one operator, and because pointing it at one Entra GROUP lets
    membership be managed in Entra instead of here:

      postgres_entra_administrators = {
        "alice@example.com" = { object_id = "..." }
        "platform-team"     = { object_id = "...", principal_type = "Group" }
      }

    Empty (the default) means no administrator is configured, and the one-time
    bootstrap can't be performed until one is.
  EOT
  type = map(object({
    object_id      = string
    principal_type = optional(string, "User")
  }))
  default = {}
}

variable "idp_metadata_url" {
  description = <<-EOT
    SAML federation metadata URL for this deployment's identity provider
    (for Entra: the enterprise application's "App Federation Metadata Url").

    Setting this makes the identity provider deployment configuration rather
    than something an admin connects in the console: the Integrations page
    shows it as managed and read-only, and the connect/disconnect endpoints
    refuse to change it. Same "deployment config is authoritative" shape as
    the machines region -- see MachineService.ts on why config beats
    admin-editable state.

    Terraform fetches the document and passes it to the container as
    IDP_METADATA_XML, because the SSO plugin takes metadata XML, never a URL.
    That means a rotated IdP signing certificate appears as a plan diff, and
    is picked up by the next apply.

    It also fixes the provider id, so the IdP's Reply URL (assertion consumer
    endpoint) is knowable before anything is connected -- with a
    console-connected provider that id is a generated row UUID, which forces
    configuring the IdP in two passes.

    Null (default) leaves the console fully in charge, which is what local
    development and any deployment without an IdP wants.
  EOT
  type        = string
  default     = null
}

variable "idp_email_domains" {
  description = <<-EOT
    Email domains the configured identity provider is authoritative for, e.g.
    ["example.com"]. Required whenever idp_metadata_url is set.

    This is load-bearing, not descriptive. @better-auth/sso only treats a SAML
    provider as trusted when the signing-in user's email domain matches one of
    these, and only a trusted provider may attach a SAML identity to an
    account that already exists. Get it wrong and every sign-in fails with
    `account_not_linked` -- which the plugin reports as a query parameter on a
    redirect rather than an error, so it is easy to misread as a silent bounce
    back to the login page.

    Matching is exact or one level of subdomain, so "example.com" also covers
    "user@eu.example.com".
  EOT
  type        = list(string)
  default     = []
}
