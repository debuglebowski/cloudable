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
  description = "Administrator password for the Postgres Flexible Server. Marked sensitive; supply via a .tfvars file that is not committed, or via TF_VAR_postgres_admin_password."
  type        = string
  sensitive   = true
}

variable "postgres_database_name" {
  description = "Name of the application database created on the Postgres server."
  type        = string
  default     = "cloudable"
}

variable "better_auth_secret" {
  description = "Secret used by BetterAuth to sign sessions (BETTER_AUTH_SECRET). Generate a random 32+ byte value, e.g. `openssl rand -base64 32`. Marked sensitive."
  type        = string
  sensitive   = true
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

