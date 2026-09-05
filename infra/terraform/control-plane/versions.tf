terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # v4.69+ required: azurerm_container_app_environment_managed_certificate
      # (the "Custom domain" section of main.tf) doesn't exist before v4.69.
      # Pinned to the 4.x line deliberately (not "~> 4.0", not "~> 5.0") —
      # v5.0 changes azurerm_role_definition.role_definition_id's format
      # (see the 5.0 upgrade guide), which this module doesn't use
      # (role_definition_resource_id is unaffected), but hasn't been
      # otherwise audited against v5's breaking changes.
      version = "~> 4.69"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Optional: only touched when var.custom_domain is set AND
    # var.cloudflare_zone_id is non-empty (see main.tf's "Custom domain"
    # section). A self-hoster who manages DNS elsewhere (or by hand) never
    # exercises this provider — declaring it unconditionally is required by
    # Terraform regardless, but an empty cloudflare_api_token never causes a
    # plan/apply failure unless a Cloudflare resource actually needs it.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "azurerm" {
  features {}
}

provider "cloudflare" {
  # The provider validates api_token's format eagerly at configure time,
  # even when nothing actually uses it (count = 0 everywhere DNS isn't
  # managed here) — an empty string fails that format check, so this must
  # be null, not "", when the var is left at its default.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}
