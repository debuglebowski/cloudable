# Cloudable — self-hosted control plane deploy (Terraform)
#
# Provisions ONE stateless container (the control plane) plus a managed
# PostgreSQL instance, in the customer's own Azure tenant. This is the
# self-hosted deployment mode (docs/spec.md §2): one trust boundary, managed
# identity, no federation — the customer runs this template once in their own
# tenant and there is nothing further to trust or configure on the Cloudable
# side. Contrast with `infra/terraform/federated-credential/`, which is the
# separate BYOC artefact a customer runs to let a Cloudable-hosted control
# plane manage machines in their tenant.
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
  public_url         = "https://${local.control_plane_fqdn}"

  # If control_plane_image already carries a digest ("<repo>@sha256:<digest>",
  # the production-pinning form described on control_plane_image_tag), don't
  # also append a tag — "<repo>@sha256:<digest>:<tag>" is not a valid image
  # reference.
  container_image = strcontains(var.control_plane_image, "@sha256:") ? var.control_plane_image : "${var.control_plane_image}:${var.control_plane_image_tag}"
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
  # (docs/spec.md §2/§10) — that's a BYOC-only concern
  # (infra/terraform/federated-credential/). This identity exists so the
  # control plane can authenticate to other Azure resources in the same
  # tenant (e.g. Key Vault, if a self-hoster later moves secrets there)
  # without ever holding a stored credential (invariant 1) — nothing is
  # granted to it by this module today.
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

      env {
        name  = "PORT"
        value = tostring(var.port)
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
