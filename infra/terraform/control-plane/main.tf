# Cloudable — self-hosted control plane deploy (Terraform)
#
# Provisions ONE stateless container (the control plane) plus a managed
# PostgreSQL instance, in the customer's own Azure tenant. This is the
# self-hosted deployment mode (docs/spec.md §2): one trust boundary, managed
# identity, no federation — the customer runs this template once in their own
# tenant and there is nothing further to trust or configure on the Cloudable
# side. This is the only deployment mode Cloudable ships — there is no
# Cloudable-hosted, multi-tenant BYOC mode (docs/cloud-auth.md).
#
# See README.md in this directory for prerequisites and exact commands.

# Federation metadata for var.idp_metadata_url. Re-read on every plan, which
# is what makes an IdP certificate rotation show up as a diff instead of a
# surprise. Public document -- it describes how to verify the IdP's
# assertions, and contains no secret.
data "http" "idp_metadata" {
  count = var.idp_metadata_url != null ? 1 : 0
  url   = var.idp_metadata_url

  lifecycle {
    postcondition {
      condition     = self.status_code == 200
      error_message = "idp_metadata_url returned HTTP ${self.status_code}, not 200 — check the URL is the IdP's federation metadata document."
    }
    postcondition {
      # Cheap shape check, matching the control plane's own
      # `looksLikeSamlMetadata`. Catches the realistic mistake: a sign-in page
      # or an error page returned with a 200.
      condition     = can(regex("EntityDescriptor", self.response_body))
      error_message = "idp_metadata_url did not return SAML federation metadata (no EntityDescriptor element)."
    }
    postcondition {
      # The control plane refuses to start without this element, so failing
      # here turns a crash-looping container into a plan-time error.
      condition     = can(regex("SingleSignOnService", self.response_body))
      error_message = "idp_metadata_url has no SingleSignOnService element — the control plane would have nowhere to redirect sign-ins."
    }
  }
}

resource "random_string" "postgres_suffix" {
  length  = 6
  special = false
  upper   = false
  numeric = true
}

locals {
  app_name             = "${var.name_prefix}-cp"
  postgres_server_name = "${var.name_prefix}-pg-${random_string.postgres_suffix.result}"
  postgres_fqdn        = azurerm_postgresql_flexible_server.this.fqdn

  # A plain variable, not derived from key_vault_id being non-null: this
  # drives `count`/`for_each` below, which Terraform must resolve at plan
  # time, and a caller's key_vault_id is typically an unknown-until-apply
  # resource attribute. See var.enable_key_vault.
  use_key_vault = var.enable_key_vault

  # Entra DB auth rides on the same user-assigned identity the Key Vault path
  # creates, so it can't be enabled on its own.
  use_entra_db_auth = var.enable_postgres_entra_auth && local.use_key_vault

  # The identity the Container App runs as, and that every role assignment
  # below binds to. User-assigned when Key Vault is in play: its principal_id
  # exists BEFORE the app does, which is what breaks the otherwise-circular
  # app -> secret reference -> role assignment -> app dependency. It also
  # survives the app being recreated, unlike the system-assigned identity
  # (see README.md's private-networking warning about re-granting).
  app_principal_id = local.use_key_vault ? azurerm_user_assigned_identity.app[0].principal_id : azurerm_container_app.this.identity[0].principal_id

  # Name the app authenticates to Postgres as. Under Entra auth that's the
  # identity itself — Azure resolves the token's principal by name, so the
  # database role created by `pgaadauth_create_principal` has to match this
  # exactly.
  postgres_login = local.use_entra_db_auth ? azurerm_user_assigned_identity.app[0].name : var.postgres_admin_username

  key_vault_secret_uri = local.use_key_vault ? "${var.key_vault_uri}secrets" : null

  # Trust anchors pulled out of the IdP's federation metadata. Only the
  # regex-extracted parts, because the document as a whole is not stable --
  # see the IDP_SAML_CONFIG env block below.
  idp_metadata_body = var.idp_metadata_url != null ? data.http.idp_metadata[0].response_body : null
  idp_saml_config = var.idp_metadata_url == null ? null : jsonencode({
    # The IdP's own entity id, which the control plane checks the assertion's
    # Issuer against. Distinct from the SP issuer this module's app advertises.
    entityId = regex("entityID=\"([^\"]+)\"", local.idp_metadata_body)[0]
    # HTTP-Redirect binding specifically: that is what an SP-initiated
    # AuthnRequest uses, and a metadata document lists several bindings.
    ssoUrl = regex("<(?:[A-Za-z0-9]+:)?SingleSignOnService[^>]*Binding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect\"[^>]*Location=\"([^\"]+)\"", local.idp_metadata_body)[0]
    # Every advertised signing certificate, de-duplicated: a metadata document
    # lists more than one during a rotation, and accepting all of them is what
    # makes a rotation a non-event rather than an outage.
    certs = distinct(flatten(regexall("<(?:[A-Za-z0-9]+:)?X509Certificate>([^<]+)</(?:[A-Za-z0-9]+:)?X509Certificate>", local.idp_metadata_body)))
    # Required, not optional: samlify (under @better-auth/sso) refuses to
    # construct an identity provider from explicit configuration without a
    # logout endpoint -- "Construct identity provider - missing endpoint of
    # SingleLogoutService", thrown per sign-in attempt, which surfaced as a
    # silent bounce back to /login. Supplying the metadata XML hides this,
    # because samlify reads the element itself; supplying fields does not.
    sloUrl = regex("<(?:[A-Za-z0-9]+:)?SingleLogoutService[^>]*Binding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect\"[^>]*Location=\"([^\"]+)\"", local.idp_metadata_body)[0]
    # Email domains this identity provider is authoritative for, comma
    # separated. Not cosmetic and not metadata-derived: @better-auth/sso only
    # treats a provider as TRUSTED when the signing-in user's email domain
    # matches (`validateEmailDomain(userInfo.email, provider.domain)`), and an
    # untrusted provider cannot attach a SAML identity to an existing
    # account -- every sign-in fails with `account_not_linked`. Matching is
    # exact or one level of subdomain.
    emailDomains = join(",", var.idp_email_domains)
  })


  # How to generate the secrets this module expects in the vault, name ->
  # { bytes }. Key Vault has no generate-secret API (its data plane offers
  # Set/Get/Update/Delete and nothing else — only *keys* and certificates are
  # generated in-vault), so the values are produced outside it. This map is
  # the single definition of what to produce; `scripts/seed-vault-secrets.sh`
  # consumes it via the `key_vault_secret_spec` output, so the names and
  # lengths exist in exactly one place rather than being restated in prose.
  #
  # `bytes`, not characters, because bytes is what is actually generated and
  # the character count follows from the encoding: base64url of B bytes is
  # exactly ceil(B*8/6) characters. A consumer that caps a secret at N
  # characters is therefore satisfied by bytes = floor(N*3/4) — 18 bytes is
  # exactly 24 characters, carrying 144 bits. Never generate long and
  # truncate: it yields the same entropy but reads like a bug, and invites a
  # later "fix" that silently changes every secret's shape.
  #
  # base64url rather than standard base64: `+`, `/` and `=` are URI-reserved
  # and have already cost this module once (see local.database_url's urlencode
  # comment below). All four are HMAC keys or a BetterAuth signing secret
  # today, none of which caps length, so the alphabet is insurance rather
  # than a current requirement.
  key_vault_secret_specs = {
    "better-auth-secret"   = { bytes = 32 } # 43 chars, 256 bits
    "join-token-secret"    = { bytes = 32 } # 43 chars, 256 bits
    "agent-session-secret" = { bytes = 32 } # 43 chars, 256 bits
    "cli-auth-code-secret" = { bytes = 32 } # 43 chars, 256 bits
  }

  # Secret names expected in the vault, doubling as the Container App secret
  # names (the app-side env var each backs is wired below). Versionless URIs
  # on purpose: rotating a secret in the vault is then picked up by a
  # revision restart, with no Terraform change.
  #
  # sort() so the Container App's `dynamic "secret"` blocks keep a stable,
  # deterministic order regardless of how the map above is written.
  key_vault_backed_secrets = sort(keys(local.key_vault_secret_specs))
  # urlencode both credential parts: a generated password commonly contains
  # URI-reserved characters (/, +, =, @, ...) that would otherwise break
  # connection-string parsing in the `postgres` client / drizzle-orm.
  #
  # sslmode=require (not verify-full) is deliberate, not an oversight, and
  # stays correct under var.enable_private_networking too: verify-full checks
  # the cert's hostname against the connection host, but Azure's own docs warn
  # against it whenever a private DNS resolver uses a different name than the
  # cert's — exactly the case here, since a VNet-integrated server's fqdn
  # resolves under our own private zone, not the public *.postgres.database
  # .azure.com name the cert is issued for.
  #
  # Under Entra auth there is no password component at all: the app supplies
  # a managed-identity token per connection instead (DATABASE_AUTH_MODE=entra,
  # see apps/control-plane/src/db/connect.ts), so this string carries only
  # host/user/database and stops being sensitive.
  database_url = local.use_entra_db_auth ? "postgres://${urlencode(local.postgres_login)}@${local.postgres_fqdn}:5432/${var.postgres_database_name}?sslmode=require" : "postgres://${urlencode(var.postgres_admin_username)}:${urlencode(var.postgres_admin_password)}@${local.postgres_fqdn}:5432/${var.postgres_database_name}?sslmode=require"

  # Azure Container Apps assigns a predictable FQDN of
  # "<app-name>.<environment-default-domain>". The environment's default
  # domain is known once the Container Apps Environment exists, before the
  # Container App itself is created, so this avoids a self-referential
  # dependency on the app's own (not-yet-created) ingress FQDN.
  control_plane_fqdn = "${local.app_name}.${azurerm_container_app_environment.this.default_domain}"
  # var.custom_domain overrides only what BETTER_AUTH_URL/CONTROL_PLANE_BASE_URL/the
  # control_plane_url output say — it does not bind anything itself (see that
  # variable's own doc comment and README.md's custom-domain recipe).
  public_url = var.custom_domain != null ? "https://${var.custom_domain}" : "https://${local.control_plane_fqdn}"

  # If control_plane_image already carries a digest ("<repo>@sha256:<digest>",
  # the production-pinning form described on control_plane_image_tag), don't
  # also append a tag — "<repo>@sha256:<digest>:<tag>" is not a valid image
  # reference.
  container_image = strcontains(var.control_plane_image, "@sha256:") ? var.control_plane_image : "${var.control_plane_image}:${var.control_plane_image_tag}"

  # Env vars ProvisioningService.azure.ts needs to manage real machines in
  # this tenant — only wired when enable_self_managed_machines actually
  # created the resource group/subnet/role below for them to point at.
  # Which providers a machine can pick is per-org/per-machine state now
  # (the Integrations page), not a boot-time adapter choice — there is no
  # `PROVISIONING_ADAPTER` env var to set here any more; setting
  # `AZURE_SUBSCRIPTION_ID` etc. is what makes Azure a *selectable* provider
  # at all (see `GET /api/v1/provisioning/capabilities`).
  machine_provisioning_env = var.enable_self_managed_machines ? [
    { name = "AZURE_SUBSCRIPTION_ID", value = data.azurerm_client_config.current.subscription_id },
    { name = "AZURE_MACHINES_RESOURCE_GROUP", value = local.machines_resource_group_name },
    { name = "AZURE_MACHINES_SUBNET_ID", value = azurerm_subnet.machines[0].id },
    # CloudCatalogService.ts's size sync filters Microsoft.Compute/skus by
    # this location server-side — confirmed live: unfiltered, that API call
    # took over two minutes for this subscription (~47k raw per-region SKU
    # records); filtered to one region, ~8 seconds. Self-hosted mode has
    # exactly one usable region anyway (machines_subnet_id below is fixed to
    # this one), so scoping the size catalog to it is also more correct, not
    # just faster — a size only available elsewhere could never actually be
    # provisioned here.
    { name = "AZURE_MACHINES_LOCATION", value = local.machines_resource_group_location },
  ] : []
}

resource "azurerm_resource_group" "this" {
  count    = var.create_resource_group ? 1 : 0
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

data "azurerm_resource_group" "this" {
  count = var.create_resource_group ? 0 : 1
  name  = var.resource_group_name
}

locals {
  resource_group_name     = var.create_resource_group ? azurerm_resource_group.this[0].name : data.azurerm_resource_group.this[0].name
  resource_group_location = var.create_resource_group ? azurerm_resource_group.this[0].location : data.azurerm_resource_group.this[0].location
}

# ---------------------------------------------------------------------------
# Private networking (opt-in, var.enable_private_networking) — a dedicated
# VNet for the control plane's own Postgres + Container Apps Environment,
# separate from the "machines" VNet below (that one is customer-VM address
# space, gated by an unrelated toggle). Postgres Flexible Server's private
# mode isn't the generic azurerm_private_endpoint resource — it's VNet
# integration via a delegated subnet + private DNS zone, both required
# together and both ForceNew (see the server resource below).
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "control_plane" {
  count               = var.enable_private_networking ? 1 : 0
  name                = "${var.name_prefix}-cp-vnet"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  address_space       = ["10.91.0.0/16"]
  tags                = var.tags
}

resource "azurerm_subnet" "postgres" {
  count                = var.enable_private_networking ? 1 : 0
  name                 = "postgres"
  resource_group_name  = local.resource_group_name
  virtual_network_name = azurerm_virtual_network.control_plane[0].name
  address_prefixes     = ["10.91.0.0/27"]

  delegation {
    name = "postgres-flexible-server"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Corrected against a real, live apply, not just docs: earlier research
# concluded a "Consumption only" (no workload_profile block) environment
# should NOT have its infrastructure subnet delegated. That's wrong in
# practice — a real `terraform apply` against this exact module failed with
# "ManagedEnvironmentSubnetDelegationError: The subnet of the environment
# must be delegated to the service 'Microsoft.App/environments'" on an
# environment with no workload_profile block at all. Delegating it (and
# sizing it /21, matching the size Microsoft's docs require alongside
# delegation) is what actually works.
resource "azurerm_subnet" "container_apps" {
  count                = var.enable_private_networking ? 1 : 0
  name                 = "container-apps"
  resource_group_name  = local.resource_group_name
  virtual_network_name = azurerm_virtual_network.control_plane[0].name
  address_prefixes     = ["10.91.8.0/21"]

  delegation {
    name = "container-apps-environment"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Name must end in ".postgres.database.azure.com" but must NOT equal the
# server's own name segment (Azure rejects that combination) — hence deriving
# it from name_prefix rather than local.postgres_server_name.
resource "azurerm_private_dns_zone" "postgres" {
  count               = var.enable_private_networking ? 1 : 0
  name                = "${var.name_prefix}.private.postgres.database.azure.com"
  resource_group_name = local.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count                 = var.enable_private_networking ? 1 : 0
  name                  = "${var.name_prefix}-cp-vnet-link"
  resource_group_name   = local.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.postgres[0].name
  virtual_network_id    = azurerm_virtual_network.control_plane[0].id
  tags                  = var.tags
}

# ---------------------------------------------------------------------------
# PostgreSQL — Azure Database for PostgreSQL Flexible Server
# ---------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server" "this" {
  name                = local.postgres_server_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

  version    = var.postgres_version
  storage_mb = var.postgres_storage_mb
  sku_name   = var.postgres_sku_name

  # Both omitted entirely under Entra-only auth: with password_auth_enabled
  # false there is no password to set, which is what finally removes the last
  # secret value from Terraform state.
  administrator_login    = local.use_entra_db_auth ? null : var.postgres_admin_username
  administrator_password = local.use_entra_db_auth ? null : var.postgres_admin_password

  # Entra ONLY — password auth off. That means the sole way into this database
  # is an Entra token: the app's managed identity for normal operation, and a
  # human listed in postgres_entra_administrators for the role bootstrap. If
  # token auth breaks, there is no password to fall back on; recovery is
  # re-enabling password auth here and applying.
  dynamic "authentication" {
    for_each = local.use_entra_db_auth ? [1] : []
    content {
      active_directory_auth_enabled = true
      password_auth_enabled         = false
      tenant_id                     = data.azurerm_client_config.current.tenant_id
    }
  }

  # Self-host is a single-trust-boundary deployment (docs/spec.md §2) — no
  # VNet peering or private endpoint plumbing by default. Reachability to the
  # control plane's Container App is granted via the "allow Azure services"
  # firewall rule below, which is broader than just this deployment (see the
  # comment on that resource). Set var.enable_private_networking = true for
  # VNet-integrated Postgres instead (see the resources above) — that's an
  # opt-in hardening step, not the default, since it forces recreation of
  # both this server and the Container Apps Environment on an
  # already-deployed instance (see that variable's own description).
  public_network_access_enabled = !var.enable_private_networking
  delegated_subnet_id           = var.enable_private_networking ? azurerm_subnet.postgres[0].id : null
  private_dns_zone_id           = var.enable_private_networking ? azurerm_private_dns_zone.postgres[0].id : null

  zone = "1"

  tags = var.tags

  lifecycle {
    ignore_changes = [zone]
  }

  # Not strictly enforced by Azure at server-creation time any more, but
  # without this Terraform has no graph edge between the server and the VNet
  # link (the server only references the DNS *zone*, not the *link*) — this
  # closes a brief window where the server could finish provisioning before
  # the zone is actually linked to the VNet, and the FQDN fails to resolve
  # from inside it. depends_on must be a static list (no ternary), so this
  # references the resource bare rather than by index — a no-op when its
  # count is 0, same pattern as allow_azure_services's own references below.
  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

# The people who can log in as an Entra admin and run the one-time
# `pgaadauth_create_principal` + GRANT for the app's identity. Terraform can't
# do that step itself — it's SQL against the server, not an ARM operation — so
# without at least one of these there is no way in to perform it. A map, since
# a deployment usually has more than one operator (or points at one group).
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "this" {
  for_each            = local.use_entra_db_auth ? var.postgres_entra_administrators : {}
  server_name         = azurerm_postgresql_flexible_server.this.name
  resource_group_name = local.resource_group_name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = each.value.object_id
  principal_name      = each.key
  principal_type      = each.value.principal_type
}

resource "azurerm_postgresql_flexible_server_database" "this" {
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Special start/end 0.0.0.0 range: Azure's documented mechanism to let the
# Container App reach this server without a static IP to allow-list. Note this
# is broader than "just this deployment" — per Microsoft's own docs it allows
# connections from IP addresses allocated to ANY Azure service, including other
# customers' subscriptions, not only this module's Container App. That's a
# deliberate simplification for a one-shot self-host template (see the
# public_network_access_enabled comment above). Meaningless (and rejected by
# the API) once private networking is on, so it doesn't exist in that mode.
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure_services" {
  count            = var.enable_private_networking ? 0 : 1
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.this.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# Ships server logs + metrics to the same Log Analytics workspace already
# provisioned below for the Container App — no second logging destination.
# Postgres's own log_statement default (not "all") keeps ingestion volume,
# and so cost, low; this only breaks down if someone later turns on
# statement-level query logging on the server itself.
resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "${local.postgres_server_name}-diagnostics"
  target_resource_id         = azurerm_postgresql_flexible_server.this.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

# Opt-in (var.alert_action_group_id) health alerts for the Postgres server.
# Deliberately permissive — Average over a full hour, not a short spike
# window, at a high threshold — to page on sustained resource pressure, not
# transient load. Metric names verified against a live server's actual
# metric definitions (`az monitor metrics list-definitions`), not assumed:
# there is no "io_consumption_percent" on Flexible Server (that's a Single
# Server metric) — the equivalent here is disk_iops_consumed_percentage.
locals {
  postgres_health_alerts = {
    cpu = {
      metric_name = "cpu_percent"
      description = "Average CPU on the control-plane Postgres server exceeded 90% over the last hour"
    }
    memory = {
      metric_name = "memory_percent"
      description = "Average memory utilization on the control-plane Postgres server exceeded 90% over the last hour"
    }
    disk_iops = {
      metric_name = "disk_iops_consumed_percentage"
      description = "Average disk IOPS consumption on the control-plane Postgres server exceeded 90% over the last hour"
    }
    storage = {
      metric_name = "storage_percent"
      description = "Average storage utilization on the control-plane Postgres server exceeded 90% over the last hour"
    }
  }
}

resource "azurerm_monitor_metric_alert" "postgres_health" {
  for_each = var.alert_action_group_id != null ? local.postgres_health_alerts : {}

  name                = "${local.postgres_server_name}-${each.key}-alert"
  resource_group_name = local.resource_group_name
  scopes              = [azurerm_postgresql_flexible_server.this.id]
  description         = each.value.description
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT1H"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = each.value.metric_name
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 90
  }

  action {
    action_group_id = var.alert_action_group_id
  }
}

# ---------------------------------------------------------------------------
# Machine provisioning — network shell + RBAC for the control plane's own
# managed identity to manage real Azure VMs in this same tenant (self-hosted
# mode: no federation, the control plane IS the trusted identity — see
# docs/cloud-auth.md's "fully managed mode uses a managed identity ... same
# provisioning-layer code path"). The "Cloudable Machine Operator" role below
# grants no NSG actions: the NSG is a Terraform-level, pre-created fact,
# never something ProvisioningService.azure.ts's runtime identity can touch —
# it can only ever join the subnet it's already attached to. A second role,
# "Cloudable Catalog Reader", grants the two subscription-scoped read actions
# CloudCatalogService.ts needs for the region/size catalog sync — see its own
# comment further down for why that can't just be folded into the first role.
# ---------------------------------------------------------------------------

data "azurerm_client_config" "current" {}
data "azurerm_subscription" "current" {}

resource "azurerm_resource_group" "machines" {
  count    = var.enable_self_managed_machines && var.create_machines_resource_group ? 1 : 0
  name     = var.machines_resource_group_name
  location = var.location
  tags     = var.tags
}

data "azurerm_resource_group" "machines" {
  count = var.enable_self_managed_machines && !var.create_machines_resource_group ? 1 : 0
  name  = var.machines_resource_group_name
}

locals {
  machines_resource_group_name = (
    !var.enable_self_managed_machines ? null :
    var.create_machines_resource_group ? azurerm_resource_group.machines[0].name : data.azurerm_resource_group.machines[0].name
  )
  machines_resource_group_location = (
    !var.enable_self_managed_machines ? null :
    var.create_machines_resource_group ? azurerm_resource_group.machines[0].location : data.azurerm_resource_group.machines[0].location
  )
  machines_resource_group_id = (
    !var.enable_self_managed_machines ? null :
    var.create_machines_resource_group ? azurerm_resource_group.machines[0].id : data.azurerm_resource_group.machines[0].id
  )
}

resource "azurerm_virtual_network" "machines" {
  count               = var.enable_self_managed_machines ? 1 : 0
  name                = "${var.name_prefix}-machines-vnet"
  resource_group_name = local.machines_resource_group_name
  location            = local.machines_resource_group_location
  address_space       = ["10.90.0.0/16"]
  tags                = var.tags
}

resource "azurerm_subnet" "machines" {
  count                = var.enable_self_managed_machines ? 1 : 0
  name                 = "machines"
  resource_group_name  = local.machines_resource_group_name
  virtual_network_name = azurerm_virtual_network.machines[0].name
  address_prefixes     = ["10.90.1.0/24"]
}

# No inbound access to any machine (invariant 7) — agents poll, tunnels are
# outbound. Nothing in this module opens any inbound port; outbound reaches
# the internet via Azure's default outbound access for the subnet.
resource "azurerm_network_security_group" "machines" {
  count               = var.enable_self_managed_machines ? 1 : 0
  name                = "${var.name_prefix}-machines-nsg"
  resource_group_name = local.machines_resource_group_name
  location            = local.machines_resource_group_location
  tags                = var.tags

  security_rule {
    name                       = "DenyAllInbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "machines" {
  count                     = var.enable_self_managed_machines ? 1 : 0
  subnet_id                 = azurerm_subnet.machines[0].id
  network_security_group_id = azurerm_network_security_group.machines[0].id
}

# ---------------------------------------------------------------------------
# Flow logs (opt-in, var.enable_flow_logs) — VNet Flow Logs, not the legacy
# NSG Flow Logs (which retire 2027-09-30 and no longer accept new setups).
# References the region's auto-created Network Watcher by Azure's own
# standard naming convention ("NetworkWatcher_<region>" in "NetworkWatcherRG")
# rather than creating one — Network Watcher is a subscription/region
# singleton, not something a single app module should own.
# ---------------------------------------------------------------------------

locals {
  # Broadened to cover the private-networking VNet too, not just machines —
  # this module assumes a single practical region throughout (see e.g. the
  # machine-size-catalog sync comment elsewhere), so falling back to the
  # control plane's own region/RG when machines are disabled is safe and,
  # for this deployment specifically (both enabled), computes to exactly the
  # same values as before — no drift on the already-existing resources below.
  flow_logs_enabled       = var.enable_flow_logs && (var.enable_self_managed_machines || var.enable_private_networking)
  flow_logs_region        = var.enable_self_managed_machines ? local.machines_resource_group_location : local.resource_group_location
  flow_logs_rg_name       = var.enable_self_managed_machines ? local.machines_resource_group_name : local.resource_group_name
  network_watcher_name    = "NetworkWatcher_${lower(replace(local.flow_logs_region, " ", ""))}"
  network_watcher_rg_name = "NetworkWatcherRG"
}

data "azurerm_network_watcher" "this" {
  count               = local.flow_logs_enabled ? 1 : 0
  name                = local.network_watcher_name
  resource_group_name = local.network_watcher_rg_name
}

resource "azurerm_storage_account" "flow_logs" {
  count                    = local.flow_logs_enabled ? 1 : 0
  name                     = "${var.name_prefix}flowlogs${random_string.postgres_suffix.result}"
  resource_group_name      = local.flow_logs_rg_name
  location                 = local.flow_logs_region
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = var.tags
}

# This storage account is itself a resource a compliance scan will flag for
# lacking health monitoring (found live: Vanta's "Storage account health
# monitored" check picked it up the run after it was created) — same
# permissive shape as the Postgres alerts above, not a separate exception.
resource "azurerm_monitor_metric_alert" "flow_logs_storage_availability" {
  count               = local.flow_logs_enabled && var.alert_action_group_id != null ? 1 : 0
  name                = "${var.name_prefix}-flow-logs-storage-availability-alert"
  resource_group_name = local.flow_logs_rg_name
  scopes              = [azurerm_storage_account.flow_logs[0].id]
  description         = "Average availability on the flow-logs storage account dropped below 95% over the last hour"
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT1H"

  criteria {
    metric_namespace = "Microsoft.Storage/storageAccounts"
    metric_name      = "Availability"
    aggregation      = "Average"
    operator         = "LessThan"
    threshold        = 95
  }

  action {
    action_group_id = var.alert_action_group_id
  }
}

# Both a VNet-level and a subnet-level flow log are created deliberately,
# even though this VNet has exactly one subnet and so this necessarily
# double-logs the same traffic: Vanta's "Virtual networks have flow logs" and
# "Subnets have flow logs" checks each look for a flow log resource scoped to
# that specific resource type, not for traffic being covered transitively.
# The 5 GB/month free tier is shared across both, per subscription, not
# doubled — combined volume for a low-traffic deployment should still fit
# comfortably within it.
resource "azurerm_network_watcher_flow_log" "machines_vnet" {
  count                = local.flow_logs_enabled && var.enable_self_managed_machines ? 1 : 0
  name                 = "${var.name_prefix}-machines-vnet-flow-log"
  network_watcher_name = data.azurerm_network_watcher.this[0].name
  resource_group_name  = data.azurerm_network_watcher.this[0].resource_group_name
  location             = local.machines_resource_group_location

  target_resource_id = azurerm_virtual_network.machines[0].id
  storage_account_id = azurerm_storage_account.flow_logs[0].id
  enabled            = true
  version            = 2

  retention_policy {
    enabled = true
    days    = 90
  }
}

resource "azurerm_network_watcher_flow_log" "machines_subnet" {
  count                = local.flow_logs_enabled && var.enable_self_managed_machines ? 1 : 0
  name                 = "${var.name_prefix}-machines-subnet-flow-log"
  network_watcher_name = data.azurerm_network_watcher.this[0].name
  resource_group_name  = data.azurerm_network_watcher.this[0].resource_group_name
  location             = local.machines_resource_group_location

  target_resource_id = azurerm_subnet.machines[0].id
  storage_account_id = azurerm_storage_account.flow_logs[0].id
  enabled            = true
  version            = 2

  retention_policy {
    enabled = true
    days    = 90
  }
}

# Same coverage for the private-networking VNet (opt-in, var.enable_flow_logs
# + var.enable_private_networking) — found live, not anticipated: closing the
# machines-network flow-log gap surfaced this VNet and its two subnets as
# their own new "needs remediation" entries once they existed (a compliance
# scan sees resources as they're created, including ones a previous fix
# itself introduced). Reuses the same storage account and Network Watcher
# reference as the machines flow logs above — no new destination needed.
resource "azurerm_network_watcher_flow_log" "control_plane_vnet" {
  count                = local.flow_logs_enabled && var.enable_private_networking ? 1 : 0
  name                 = "${var.name_prefix}-cp-vnet-flow-log"
  network_watcher_name = data.azurerm_network_watcher.this[0].name
  resource_group_name  = data.azurerm_network_watcher.this[0].resource_group_name
  location             = local.flow_logs_region

  target_resource_id = azurerm_virtual_network.control_plane[0].id
  storage_account_id = azurerm_storage_account.flow_logs[0].id
  enabled            = true
  version            = 2

  retention_policy {
    enabled = true
    days    = 90
  }
}

resource "azurerm_network_watcher_flow_log" "control_plane_postgres_subnet" {
  count                = local.flow_logs_enabled && var.enable_private_networking ? 1 : 0
  name                 = "${var.name_prefix}-cp-postgres-subnet-flow-log"
  network_watcher_name = data.azurerm_network_watcher.this[0].name
  resource_group_name  = data.azurerm_network_watcher.this[0].resource_group_name
  location             = local.flow_logs_region

  target_resource_id = azurerm_subnet.postgres[0].id
  storage_account_id = azurerm_storage_account.flow_logs[0].id
  enabled            = true
  version            = 2

  retention_policy {
    enabled = true
    days    = 90
  }
}

resource "azurerm_network_watcher_flow_log" "control_plane_container_apps_subnet" {
  count                = local.flow_logs_enabled && var.enable_private_networking ? 1 : 0
  name                 = "${var.name_prefix}-cp-container-apps-subnet-flow-log"
  network_watcher_name = data.azurerm_network_watcher.this[0].name
  resource_group_name  = data.azurerm_network_watcher.this[0].resource_group_name
  location             = local.flow_logs_region

  target_resource_id = azurerm_subnet.container_apps[0].id
  storage_account_id = azurerm_storage_account.flow_logs[0].id
  enabled            = true
  version            = 2

  retention_policy {
    enabled = true
    days    = 90
  }
}

# ---------------------------------------------------------------------------
# App identity + Key Vault access (opt-in, var.key_vault_id)
#
# A user-assigned identity, created ahead of the Container App, is what makes
# Key Vault secret references possible at all: the app can't start until it
# can resolve those references, resolving them needs a role assignment, and a
# role assignment needs a principal — which, with a system-assigned identity,
# only exists once the app is already running. Creating the identity as its
# own resource cuts that cycle.
#
# Deliberately NOT creating the vault or its secrets here — see
# var.key_vault_id. Secrets are written out-of-band precisely so their values
# never enter Terraform state.
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "app" {
  count               = local.use_key_vault ? 1 : 0
  name                = "id-${local.app_name}"
  location            = local.resource_group_location
  resource_group_name = local.resource_group_name
  tags                = var.tags
}

# The two signing keys, generated INSIDE the vault. Terraform never sees the
# private half: `azurerm_key_vault_key` with no imported material makes Key
# Vault generate the pair and return only the public key, so unlike a secret's
# `value` there is nothing private to land in state. That is what actually
# satisfies invariant #9 ("the CA private key never enters the control plane") —
# the app calls /sign, never /export.
#
# EC P-256, because Key Vault has no Ed25519 (RSA, EC, oct only). The
# certificate format follows from that: see openssh-cert.ts's CA_KEY_TYPE.
#
# Creating a key is a data-plane operation, so the deploying identity needs
# "Key Vault Crypto Officer" on the vault — granted below from
# deploying_identity_principal_id, the same way this module already grants
# that identity the role-assignment read it needs. That grant allows creating,
# rotating and deleting keys; it does NOT allow reading private key material,
# which Key Vault never returns for a key it generated.
resource "azurerm_key_vault_key" "signing" {
  # Names match the app's own key ids (SshCaService.SSH_CA_KEY_ID,
  # session-token.ts's SESSION_TOKEN_KEY_ID) — the Signer port passes them
  # straight through as Key Vault key names.
  for_each = local.use_key_vault ? toset(["ssh-ca", "session-token"]) : toset([])

  name         = each.key
  key_vault_id = var.key_vault_id
  key_type     = "EC"
  curve        = "P-256"
  key_opts     = ["sign", "verify"]

  # RBAC propagation isn't instant — a first apply can still 403 here even
  # with the grant ordered before it, and succeed on a re-run.
  depends_on = [azurerm_role_assignment.deployer_key_vault_crypto]
}

resource "azurerm_role_assignment" "deployer_key_vault_crypto" {
  count                = local.use_key_vault && var.deploying_identity_principal_id != null ? 1 : 0
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Crypto Officer"
  principal_id         = var.deploying_identity_principal_id
}

# Sign and verify only — not Crypto Officer, which could create, import or
# delete keys. The app never needs to do any of those.
resource "azurerm_role_assignment" "app_key_vault_crypto" {
  count                = local.use_key_vault ? 1 : 0
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.app[0].principal_id
}

resource "azurerm_role_assignment" "app_key_vault_secrets" {
  count = local.use_key_vault ? 1 : 0
  scope = var.key_vault_id
  # Read-only on secret VALUES. Not "Key Vault Secrets Officer" — the app
  # never writes or rotates a secret, it only resolves the four it's given.
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app[0].principal_id
}

# Metadata only: "Key Vault Reader" grants readMetadata — list secret names,
# read their properties — and explicitly NOT getSecret. Microsoft's role
# table describes it as "Cannot read sensitive values such as secret
# contents". It exists solely so the `check` block below can tell you the
# vault is unseeded; the deploying identity gains no ability to read a value.
#
# Same gate and rationale as deployer_key_vault_crypto above. Note this is
# vault-scoped, so it needs Microsoft.Authorization/roleAssignments/write on
# the vault, which Contributor does not grant — expect the same one-time
# elevated creation the other vault role assignments need. Without it the
# check degrades to a warning, which is annoying and never blocking.
resource "azurerm_role_assignment" "deployer_key_vault_reader" {
  count                = local.use_key_vault && var.deploying_identity_principal_id != null ? 1 : 0
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Reader"
  principal_id         = var.deploying_identity_principal_id
}

# Confirms the vault actually holds the secrets this deployment references.
#
# `azurerm_key_vault_secrets` is the PLURAL, metadata-only data source: its
# attributes are `names` and a `secrets` list of {enabled, id, name, tags}.
# It has no `value` attribute at all, so unlike the singular
# `azurerm_key_vault_secret` (whose `value` is sensitive) there is nothing
# here that could put a secret into state. That is the entire reason it is
# this data source.
#
# A `check` block rather than a lifecycle.precondition, deliberately: an
# unseeded vault should warn loudly, but a vault that is momentarily
# unreadable — RBAC still propagating, network rules added later, data-plane
# throttling, or simply no Key Vault Reader grant — must not wedge every
# future apply of an image bump that has nothing to do with secrets. Check
# assertions and scoped data-source failures are warnings by design.
#
# This is early notice, not the only line of defence: Container Apps cannot
# provision a revision whose key_vault_secret_id fails to resolve, so a
# missing secret is already fatal at deploy time. The point is to say so at
# plan time, with the fix, instead of at revision-provisioning time.
#
# The nested data block cannot take `count` ("The count meta-argument is not
# supported within nested data blocks" — verified, not assumed), so with
# enable_key_vault unset it is still evaluated, reads a null key_vault_id and
# emits one warning per plan. That is the deliberate trade: the alternative
# is a top-level counted data source, where a read failure becomes a HARD
# error and any deployment whose identity lacks readMetadata on the vault
# could no longer plan at all. A spurious warning for non-vault users is a
# far better failure mode than a wedged pipeline for vault users.
check "key_vault_secrets_seeded" {
  data "azurerm_key_vault_secrets" "expected" {
    key_vault_id = var.key_vault_id
  }

  assert {
    # Ternary rather than `||` so the data source is never dereferenced when
    # Key Vault is disabled (both branches of `||` get evaluated).
    condition = !local.use_key_vault || length(setsubtract(
      toset(local.key_vault_backed_secrets),
      toset(data.azurerm_key_vault_secrets.expected.names)
    )) == 0

    error_message = join(" ", [
      "Key Vault is missing secrets this deployment references:",
      join(", ", sort(tolist(setsubtract(
        toset(local.key_vault_backed_secrets),
        toset(try(data.azurerm_key_vault_secrets.expected.names, []))
      )))),
      "— the Container App cannot provision a revision until they exist.",
      "Seed them with scripts/seed-vault-secrets.sh (see README.md).",
      "If the vault IS seeded, the deploying identity most likely lacks",
      "Microsoft.KeyVault/vaults/secrets/readMetadata/action on it; grant it",
      "'Key Vault Reader', which reads metadata only and never values.",
    ])
  }
}

resource "azurerm_role_definition" "machine_operator" {
  count       = var.enable_self_managed_machines ? 1 : 0
  name        = "Cloudable Machine Operator (${var.name_prefix})"
  scope       = local.machines_resource_group_id
  description = "Least-privilege role for the control plane's own provisioning code, scoped to a single dedicated resource group. Never Contributor, never subscription scope (docs/spec.md §10)."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/start/action",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/virtualMachines/restart/action",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/write",
      "Microsoft.Compute/disks/delete",
      # Snapshotting a disk is authorized against BOTH scopes: `snapshots/write`
      # on the snapshot being created, and `disks/beginGetAccess/action` on the
      # source disk it copies from. Without the second, archive fails at the
      # snapshot step with `LinkedAuthorizationFailed` — and ARM does not record
      # a linked-authorization failure in the Activity Log at all, so the only
      # evidence is the control plane's own error. `endGetAccess` is its pair,
      # releasing the access `begin` takes.
      "Microsoft.Compute/disks/beginGetAccess/action",
      "Microsoft.Compute/disks/endGetAccess/action",
      "Microsoft.Compute/snapshots/read",
      "Microsoft.Compute/snapshots/write",
      "Microsoft.Compute/snapshots/delete",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkInterfaces/write",
      "Microsoft.Network/networkInterfaces/delete",
      "Microsoft.Network/networkInterfaces/join/action",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/subnets/read",
      "Microsoft.Network/virtualNetworks/subnets/join/action",
      "Microsoft.Network/publicIPAddresses/read",
      "Microsoft.Network/publicIPAddresses/write",
      "Microsoft.Network/publicIPAddresses/delete",
      "Microsoft.Network/publicIPAddresses/join/action",
    ]
    not_actions = []
  }

  assignable_scopes = [local.machines_resource_group_id]
}

resource "azurerm_role_assignment" "machine_operator" {
  count              = var.enable_self_managed_machines ? 1 : 0
  scope              = local.machines_resource_group_id
  role_definition_id = azurerm_role_definition.machine_operator[0].role_definition_resource_id
  principal_id       = local.app_principal_id
}

# `CloudCatalogService.ts`'s region/size sync (SubscriptionClient.subscriptions.
# listLocations / ComputeManagementClient.resourceSkus.list) reads subscription-
# level resources, not resource-group-level ones — "Cloudable Machine Operator"
# above can't be extended to cover them without moving its own scope (and every
# VM/disk/NIC action it grants) up to the whole subscription, which is exactly
# what docs/spec.md §10 rules out. So this is a second, separate, read-only
# role, assigned at subscription scope, and nothing else changes.
resource "azurerm_role_definition" "catalog_reader" {
  count       = var.enable_self_managed_machines ? 1 : 0
  name        = "Cloudable Catalog Reader (${var.name_prefix})"
  scope       = data.azurerm_subscription.current.id
  description = "Read-only, subscription-scoped: lets the control plane list regions/VM sizes to sync the org-curated machine catalog. No write actions."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/locations/read",
      "Microsoft.Compute/skus/read",
    ]
    not_actions = []
  }

  assignable_scopes = [data.azurerm_subscription.current.id]
}

resource "azurerm_role_assignment" "catalog_reader" {
  count              = var.enable_self_managed_machines ? 1 : 0
  scope              = data.azurerm_subscription.current.id
  role_definition_id = azurerm_role_definition.catalog_reader[0].role_definition_resource_id
  principal_id       = local.app_principal_id
}

# A third, separate role — not for the control plane's own managed identity,
# but for whatever *deploying* identity runs terraform against this module.
# catalog_reader above is itself a subscription-scoped resource, and Terraform
# needs Microsoft.Authorization/roleAssignments/read at that scope just to
# read it back on every plan/apply. A scoped-down deploying identity (see
# create_resource_group's own description above for why one would be scoped
# down at all) doesn't have that by default, so `tofu plan` computes the
# correct diff and then 403s trying to confirm the resource is unchanged.
# Opt-in only (deploying_identity_principal_id defaults to null) since a
# deploying identity with broader access already doesn't need this.
resource "azurerm_role_definition" "deploying_identity_role_assignment_reader" {
  count       = var.enable_self_managed_machines && var.deploying_identity_principal_id != null ? 1 : 0
  name        = "Cloudable Deploying-Identity Role Assignment Reader (${var.name_prefix})"
  scope       = data.azurerm_subscription.current.id
  description = "Read-only, subscription-scoped: lets a scoped-down deploying identity (e.g. CI/CD) read this module's own role assignments during terraform plan/apply. No write actions."

  permissions {
    actions = [
      "Microsoft.Authorization/roleAssignments/read",
    ]
    not_actions = []
  }

  assignable_scopes = [data.azurerm_subscription.current.id]
}

resource "azurerm_role_assignment" "deploying_identity_role_assignment_reader" {
  count              = var.enable_self_managed_machines && var.deploying_identity_principal_id != null ? 1 : 0
  scope              = data.azurerm_subscription.current.id
  role_definition_id = azurerm_role_definition.deploying_identity_role_assignment_reader[0].role_definition_resource_id
  principal_id       = var.deploying_identity_principal_id
}

# ---------------------------------------------------------------------------
# Container Apps — the control plane, one stateless container
# ---------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name_prefix}-cp-logs"
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${var.name_prefix}-cp-env"
  resource_group_name        = local.resource_group_name
  location                   = local.resource_group_location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = var.tags

  # Gives this environment DNS visibility into the VNet the Postgres private
  # zone above is linked to, so it can resolve/reach the server once
  # public_network_access_enabled is off.
  infrastructure_subnet_id = var.enable_private_networking ? azurerm_subnet.container_apps[0].id : null

  # Corrected against a real, live apply, not just docs/provider source:
  # earlier research concluded a VNet-integrated environment with no
  # workload_profile block stays "Consumption only" and doesn't need one.
  # Two things about that turned out wrong in practice: the subnet actually
  # needs delegating to Microsoft.App/environments regardless (see the
  # container_apps subnet's own comment), and once that delegation is in
  # place, Azure silently attaches a default Consumption workload profile
  # to the environment on its own -- declaring it explicitly here isn't
  # optional, it's what stops every future plan from showing perpetual
  # drift trying to remove a profile Azure just re-adds anyway.
  dynamic "workload_profile" {
    for_each = var.enable_private_networking ? [1] : []
    content {
      name                  = "Consumption"
      workload_profile_type = "Consumption"
      # Not computed fields — Azure reports these as 0 for a Consumption
      # profile (it doesn't use fixed min/max the way Dedicated profiles
      # do), and leaving them unset here would drift against that on every
      # plan, the same way the whole block did before it was declared.
      maximum_count = 0
      minimum_count = 0
    }
  }
}

resource "azurerm_container_app" "this" {
  name                         = local.app_name
  resource_group_name          = local.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  tags                         = var.tags

  # Same drift as the environment's own workload_profile block above and
  # for the same reason: once the environment has a Consumption workload
  # profile (declared or, as discovered, auto-attached by Azure regardless),
  # the app itself reports back workload_profile_name = "Consumption" too —
  # not computed, so leaving it unset here drifts on every plan.
  workload_profile_name = var.enable_private_networking ? "Consumption" : null

  # System-assigned managed identity. Self-hosted mode has no federation
  # (docs/spec.md §2/§10) — no BYOC mode exists to need it (docs/cloud-auth.md).
  # This identity exists so the control plane can authenticate to other Azure resources in the same
  # tenant without ever holding a stored credential (invariant 1) — granted
  # the "Cloudable Machine Operator" role below (when
  # enable_self_managed_machines is true) so ProvisioningService.azure.ts
  # can manage real VMs; otherwise nothing is granted to it.
  # User-assigned once Key Vault is in play (see azurerm_user_assigned_identity
  # .app above for why); system-assigned otherwise, unchanged for every
  # existing deployment that doesn't set key_vault_id.
  identity {
    type         = local.use_key_vault ? "UserAssigned" : "SystemAssigned"
    identity_ids = local.use_key_vault ? [azurerm_user_assigned_identity.app[0].id] : null
  }

  # Not a Key Vault reference: under Entra auth this carries no password at
  # all (see local.database_url), and under password auth it's the same
  # inline value it has always been.
  secret {
    name  = "database-url"
    value = local.database_url
  }

  # The four signing secrets. With key_vault_id set these carry only a URI —
  # Container Apps resolves the value itself at container start using the
  # identity above, so nothing sensitive reaches Terraform state and the
  # application still just reads an environment variable.
  dynamic "secret" {
    for_each = local.use_key_vault ? toset(local.key_vault_backed_secrets) : toset([])
    content {
      name                = secret.value
      key_vault_secret_id = "${local.key_vault_secret_uri}/${secret.value}"
      identity            = azurerm_user_assigned_identity.app[0].id
    }
  }

  dynamic "secret" {
    for_each = local.use_key_vault ? [] : [1]
    content {
      name  = "better-auth-secret"
      value = var.better_auth_secret
    }
  }

  dynamic "secret" {
    for_each = var.control_plane_image_registry_password != "" ? [1] : []
    content {
      name  = "registry-password"
      value = var.control_plane_image_registry_password
    }
  }

  dynamic "secret" {
    for_each = var.default_admin_password != null ? [1] : []
    content {
      name  = "default-admin-password"
      value = var.default_admin_password
    }
  }

  dynamic "registry" {
    for_each = var.control_plane_image_registry_password != "" ? [1] : []
    content {
      server               = var.control_plane_image_registry_server
      username             = var.control_plane_image_registry_username
      password_secret_name = "registry-password"
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "control-plane"
      image  = local.container_image
      cpu    = var.container_cpu
      memory = var.container_memory

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "BETTER_AUTH_SECRET"
        secret_name = "better-auth-secret"
      }

      env {
        name  = "BETTER_AUTH_URL"
        value = local.public_url
      }

      # ProvisioningService.azure.ts's cloud-init needs this to be the
      # control plane's real, publicly reachable URL, not localhost — a
      # fresh Azure VM curls its agent/tunnel-daemon binaries from here.
      env {
        name  = "CONTROL_PLANE_BASE_URL"
        value = local.public_url
      }

      env {
        name  = "PORT"
        value = tostring(var.port)
      }

      dynamic "env" {
        for_each = local.machine_provisioning_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      # Appended last, deliberately: each `dynamic "env"` block above is a
      # fixed-size list (0 or 1 elements), so an env var conditionally added
      # earlier in this list shifts every later block's position — and
      # `azurerm_container_app`'s `env` blocks have no stable per-entry key,
      # so Terraform reads a position shift as every later entry's `name`/
      # `value` having changed in place. Adding new optional vars here,
      # after every existing one, keeps unrelated plans clean.
      dynamic "env" {
        for_each = var.default_admin_email != null ? [1] : []
        content {
          name  = "DEFAULT_ADMIN_EMAIL"
          value = var.default_admin_email
        }
      }

      dynamic "env" {
        for_each = var.default_admin_password != null ? [1] : []
        content {
          name        = "DEFAULT_ADMIN_PASSWORD"
          secret_name = "default-admin-password"
        }
      }

      # The three signing secrets that were never wired here before. Without
      # them the app falls back to the literal "dev-only-change-me" baked
      # into JoinTokenAttestation.ts / AgentSessionToken.ts / CliAuthCode.ts
      # — a published default in an MIT-licensed repo, which means agent join
      # tokens, agent session tokens and CLI sign-in codes were signed with a
      # publicly known key. Only available via Key Vault: there is no plain-
      # value fallback on purpose, so nothing silently keeps running on the
      # default.
      dynamic "env" {
        for_each = local.use_key_vault ? [1] : []
        content {
          name        = "JOIN_TOKEN_SECRET"
          secret_name = "join-token-secret"
        }
      }

      dynamic "env" {
        for_each = local.use_key_vault ? [1] : []
        content {
          name        = "AGENT_SESSION_SECRET"
          secret_name = "agent-session-secret"
        }
      }

      dynamic "env" {
        for_each = local.use_key_vault ? [1] : []
        content {
          name        = "CLI_AUTH_CODE_SECRET"
          secret_name = "cli-auth-code-secret"
        }
      }

      # Tells DefaultAzureCredential which identity to use — with a
      # user-assigned identity there's no single implicit one to fall back
      # on, so ProvisioningService.azure.ts and db/connect.ts would otherwise
      # both fail to get a token.
      dynamic "env" {
        for_each = local.use_key_vault ? [1] : []
        content {
          name  = "AZURE_CLIENT_ID"
          value = azurerm_user_assigned_identity.app[0].client_id
        }
      }

      dynamic "env" {
        for_each = local.use_entra_db_auth ? [1] : []
        content {
          name  = "DATABASE_AUTH_MODE"
          value = "entra"
        }
      }

      # Switches the control plane from the in-process key generator
      # (Signer.local.ts) to Key Vault (Signer.azure.ts) for the SSH CA and
      # session-token keys.
      dynamic "env" {
        for_each = local.use_key_vault ? [1] : []
        content {
          name  = "KEY_VAULT_URI"
          value = var.key_vault_uri
        }
      }

      # Appended last, same reason as the blocks below.
      #
      # The console is served by THIS container, at every path outside
      # /api/* and /_internal/*, so its origin is this deployment's own
      # public URL. Left unset the app falls back to the vite dev server on
      # localhost:5180 -- which is invisible in production until something
      # compares against it, and then badly misleading: BetterAuth's
      # trustedOrigins is one such place, and a deployment that trusted only
      # a developer's laptop rejected every SSO callbackURL it was given.
      env {
        name  = "CONSOLE_ORIGIN"
        value = local.public_url
      }

      # The SAML identity provider, when this deployment declares one rather
      # than having an admin connect it through the console. Appended last,
      # deliberately: inserting an env block mid-list reads as every later
      # entry changing (see the comment further up this container block).
      dynamic "env" {
        for_each = var.idp_metadata_url != null ? [1] : []
        content {
          name  = "IDP_METADATA_URL"
          value = var.idp_metadata_url
        }
      }

      dynamic "env" {
        for_each = var.idp_metadata_url != null ? [1] : []
        content {
          name = "IDP_SAML_CONFIG"
          # The trust anchors extracted from the metadata, NOT the document
          # itself. Entra regenerates the EntityDescriptor's ID and its
          # enclosing Signature on every single request, so passing the raw
          # XML made this container app diff on every plan and restart on
          # every apply -- measured, not theorised: two fetches a second
          # apart differ, while entityID and the certificates are identical.
          #
          # These three fields are what @better-auth/sso actually needs, and
          # its SAMLIdentityProviderMetadata type accepts them directly in
          # place of `metadata`. They are stable until the IdP rotates its
          # signing certificate -- which is exactly when a diff here is the
          # signal you want.
          value = local.idp_saml_config
        }
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = var.port
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  depends_on = [
    azurerm_postgresql_flexible_server_database.this,
    azurerm_postgresql_flexible_server_firewall_rule.allow_azure_services,
  ]

  # `better_auth_secret` is optional only because the Key Vault path supplies
  # it from the vault instead. Without either, the app would come up with an
  # empty session-signing secret rather than failing — catch it at plan time.
  # A `validation` block on the variable itself can't express this: those
  # couldn't reference other variables until Terraform 1.9, and this module
  # supports 1.5+.
  lifecycle {
    precondition {
      condition     = local.use_key_vault || var.better_auth_secret != null
      error_message = "better_auth_secret must be set unless enable_key_vault is (in which case the vault supplies it as `better-auth-secret`)."
    }
    precondition {
      condition     = var.idp_metadata_url == null || length(var.idp_email_domains) > 0
      error_message = "idp_email_domains is required with idp_metadata_url: @better-auth/sso only trusts a provider for users whose email domain matches, and without a match every SSO sign-in fails with account_not_linked."
    }
    precondition {
      condition     = !var.enable_key_vault || (var.key_vault_id != null && var.key_vault_uri != null)
      error_message = "enable_key_vault requires both key_vault_id and key_vault_uri."
    }
    precondition {
      condition     = var.enable_postgres_entra_auth || var.postgres_admin_password != null
      error_message = "postgres_admin_password is required unless enable_postgres_entra_auth is set (which disables password auth entirely)."
    }
    precondition {
      condition     = !var.enable_postgres_entra_auth || local.use_key_vault
      error_message = "enable_postgres_entra_auth requires enable_key_vault: it reuses the user-assigned identity that path creates."
    }
  }
}
