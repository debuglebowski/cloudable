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
# PostgreSQL — Azure Database for PostgreSQL Flexible Server
# ---------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server" "this" {
  name                = local.postgres_server_name
  resource_group_name = local.resource_group_name
  location            = local.resource_group_location

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

  assignable_scopes = [local.machines_resource_group_id]
}

resource "azurerm_role_assignment" "machine_operator" {
  count              = var.enable_self_managed_machines ? 1 : 0
  scope              = local.machines_resource_group_id
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
}

resource "azurerm_container_app" "this" {
  name                         = local.app_name
  resource_group_name          = local.resource_group_name
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
