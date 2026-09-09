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
  #
  # sslmode=require (not verify-full) is deliberate, not an oversight, and
  # stays correct under var.enable_private_networking too: verify-full checks
  # the cert's hostname against the connection host, but Azure's own docs warn
  # against it whenever a private DNS resolver uses a different name than the
  # cert's — exactly the case here, since a VNet-integrated server's fqdn
  # resolves under our own private zone, not the public *.postgres.database
  # .azure.com name the cert is issued for.
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

  administrator_login    = var.postgres_admin_username
  administrator_password = var.postgres_admin_password

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
  flow_logs_enabled       = var.enable_flow_logs && var.enable_self_managed_machines
  network_watcher_name    = "NetworkWatcher_${lower(replace(local.machines_resource_group_location, " ", ""))}"
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
  resource_group_name      = local.machines_resource_group_name
  location                 = local.machines_resource_group_location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = var.tags
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
  count                = local.flow_logs_enabled ? 1 : 0
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
  count                = local.flow_logs_enabled ? 1 : 0
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
