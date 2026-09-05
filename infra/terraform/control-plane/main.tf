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
  # urlencode both credential parts: a generated password commonly contains
  # URI-reserved characters (/, +, =, @, ...) that would otherwise break
  # connection-string parsing in the `postgres` client / drizzle-orm.
  database_url = "postgres://${urlencode(var.postgres_admin_username)}:${urlencode(var.postgres_admin_password)}@${local.postgres_fqdn}:5432/${var.postgres_database_name}?sslmode=require"

  # Azure Container Apps assigns a predictable FQDN of
  # "<app-name>.<environment-default-domain>". The environment's default
  # domain is known once the Container Apps Environment exists, before the
  # Container App itself is created, so this avoids a self-referential
  # dependency on the app's own (not-yet-created) ingress FQDN.
  control_plane_fqdn = "${local.app_name}.${azurerm_container_app_environment.this.default_domain}"
  # The control plane's real public URL: var.custom_domain once bound (see
  # the "Custom domain" section below), else the auto-generated FQDN above.
  # Feeds BETTER_AUTH_URL and CONTROL_PLANE_BASE_URL — both need to be the
  # exact hostname a browser/agent actually reaches this deployment at.
  public_url = var.custom_domain != null ? "https://${var.custom_domain}" : "https://${local.control_plane_fqdn}"

  manage_dns_in_cloudflare = var.custom_domain != null && var.cloudflare_zone_id != ""

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
    { name = "AZURE_MACHINES_RESOURCE_GROUP", value = azurerm_resource_group.machines[0].name },
    { name = "AZURE_MACHINES_SUBNET_ID", value = azurerm_subnet.machines[0].id },
  ] : []
}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

# ---------------------------------------------------------------------------
# PostgreSQL — Azure Database for PostgreSQL Flexible Server
# ---------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server" "this" {
  name                = local.postgres_server_name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location

  version    = var.postgres_version
  storage_mb = var.postgres_storage_mb
  sku_name   = var.postgres_sku_name

  administrator_login    = var.postgres_admin_username
  administrator_password = var.postgres_admin_password

  # Self-host is a single-trust-boundary deployment (docs/spec.md §2) — no
  # VNet peering or private endpoint plumbing. Reachability to the control
  # plane's Container App is granted via the "allow Azure services" firewall
  # rule below, which is broader than just this deployment (see the comment on
  # that resource). A self-hoster who wants VNet-integrated Postgres instead
  # can fork this module; that's a deliberately out-of-scope hardening step
  # here.
  public_network_access_enabled = true

  zone = "1"

  tags = var.tags

  lifecycle {
    ignore_changes = [zone]
  }
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
# public_network_access_enabled comment above); harden with VNet integration /
# private endpoints yourself if your compliance posture requires it.
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.this.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
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
  count    = var.enable_self_managed_machines ? 1 : 0
  name     = var.machines_resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "machines" {
  count               = var.enable_self_managed_machines ? 1 : 0
  name                = "${var.name_prefix}-machines-vnet"
  resource_group_name = azurerm_resource_group.machines[0].name
  location            = azurerm_resource_group.machines[0].location
  address_space       = ["10.90.0.0/16"]
  tags                = var.tags
}

resource "azurerm_subnet" "machines" {
  count                = var.enable_self_managed_machines ? 1 : 0
  name                 = "machines"
  resource_group_name  = azurerm_resource_group.machines[0].name
  virtual_network_name = azurerm_virtual_network.machines[0].name
  address_prefixes     = ["10.90.1.0/24"]
}

# No inbound access to any machine (invariant 7) — agents poll, tunnels are
# outbound. Nothing in this module opens any inbound port; outbound reaches
# the internet via Azure's default outbound access for the subnet.
resource "azurerm_network_security_group" "machines" {
  count               = var.enable_self_managed_machines ? 1 : 0
  name                = "${var.name_prefix}-machines-nsg"
  resource_group_name = azurerm_resource_group.machines[0].name
  location            = azurerm_resource_group.machines[0].location
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

resource "azurerm_role_definition" "machine_operator" {
  count       = var.enable_self_managed_machines ? 1 : 0
  name        = "Cloudable Machine Operator (${var.name_prefix})"
  scope       = azurerm_resource_group.machines[0].id
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
      "Microsoft.Compute/snapshots/read",
      "Microsoft.Compute/snapshots/write",
      "Microsoft.Compute/snapshots/delete",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkInterfaces/write",
      "Microsoft.Network/networkInterfaces/delete",
      "Microsoft.Network/networkInterfaces/join/action",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/subnets/join/action",
      "Microsoft.Network/publicIPAddresses/read",
      "Microsoft.Network/publicIPAddresses/write",
      "Microsoft.Network/publicIPAddresses/delete",
      "Microsoft.Network/publicIPAddresses/join/action",
    ]
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.machines[0].id]
}

resource "azurerm_role_assignment" "machine_operator" {
  count              = var.enable_self_managed_machines ? 1 : 0
  scope              = azurerm_resource_group.machines[0].id
  role_definition_id = azurerm_role_definition.machine_operator[0].role_definition_resource_id
  principal_id       = azurerm_container_app.this.identity[0].principal_id
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
  principal_id       = azurerm_container_app.this.identity[0].principal_id
}

# ---------------------------------------------------------------------------
# Container Apps — the control plane, one stateless container
# ---------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name_prefix}-cp-logs"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${var.name_prefix}-cp-env"
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = var.tags
}

resource "azurerm_container_app" "this" {
  name                         = local.app_name
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  tags                         = var.tags

  # System-assigned managed identity. Self-hosted mode has no federation
  # (docs/spec.md §2/§10) — no BYOC mode exists to need it (docs/cloud-auth.md).
  # This identity exists so the control plane can authenticate to other Azure resources in the same
  # tenant without ever holding a stored credential (invariant 1) — granted
  # the "Cloudable Machine Operator" role below (when
  # enable_self_managed_machines is true) so ProvisioningService.azure.ts
  # can manage real VMs; otherwise nothing is granted to it.
  identity {
    type = "SystemAssigned"
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  secret {
    name  = "better-auth-secret"
    value = var.better_auth_secret
  }

  dynamic "secret" {
    for_each = var.control_plane_image_registry_password != "" ? [1] : []
    content {
      name  = "registry-password"
      value = var.control_plane_image_registry_password
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
}

# ---------------------------------------------------------------------------
# Custom domain — entirely optional (var.custom_domain defaults to null, in
# which case none of this exists and the auto-generated Container Apps FQDN
# is used, same as before this section existed).
#
# Azure requires proof of domain ownership before it will bind a custom
# hostname: a TXT record at "asuid.<domain>" containing the Container App's
# own custom_domain_verification_id. var.cloudflare_zone_id lets this module
# create that (and the CNAME routing traffic to the app) for you when your
# DNS is on Cloudflare; leave it empty to manage those two records yourself
# on whatever DNS you use — this module's plan output still tells you the
# exact values to put in them (see README.md).
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "verification" {
  count   = local.manage_dns_in_cloudflare ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "asuid.${var.custom_domain}"
  type    = "TXT"
  content = azurerm_container_app.this.custom_domain_verification_id
  ttl     = 300
  # Domain-ownership verification and Azure's own managed-certificate
  # issuance below both need to see this record directly, not through
  # Cloudflare's proxy.
  proxied = false
}

resource "cloudflare_dns_record" "cname" {
  count   = local.manage_dns_in_cloudflare ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.custom_domain
  type    = "CNAME"
  content = local.control_plane_fqdn
  ttl     = 300
  # Same reasoning as the TXT record above — proxying this would put
  # Cloudflare's edge, not Azure, in the TLS/HTTP path Azure is validating.
  proxied = false
}

resource "azurerm_container_app_custom_domain" "this" {
  count            = var.custom_domain != null ? 1 : 0
  name             = var.custom_domain
  container_app_id = azurerm_container_app.this.id

  # certificate_binding_type is set asynchronously by Azure once the managed
  # certificate below finishes issuing — without ignoring it, every
  # subsequent plan would see drift. (v3-era docs/examples also list
  # container_app_environment_certificate_id here; on azurerm v4.81.0 the
  # renamed equivalent, container_app_environment_managed_certificate_id, is
  # purely computed — `tofu validate` confirmed it can never appear in a
  # config diff at all, so listing it here is a no-op, not just redundant.)
  lifecycle {
    ignore_changes = [certificate_binding_type]
  }

  depends_on = [cloudflare_dns_record.verification, cloudflare_dns_record.cname]
}

resource "azurerm_container_app_environment_managed_certificate" "this" {
  count                        = var.custom_domain != null ? 1 : 0
  name                         = "${var.name_prefix}-cp-cert"
  container_app_environment_id = azurerm_container_app_environment.this.id
  subject_name                 = var.custom_domain
  domain_control_validation    = "CNAME"

  depends_on = [azurerm_container_app_custom_domain.this]
}
