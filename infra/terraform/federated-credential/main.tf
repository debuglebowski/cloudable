# Cloudable workload identity federation — the customer's side.
#
# Run this in the customer's own Azure AD tenant / subscription, under
# THEIR OWN credentials (e.g. `az login`) — Cloudable is never given
# credentials to run this itself (invariant #1: no cloud credential is ever
# stored, federation only). See docs/cloud-auth.md for the full flow and
# ../../../docs/spec.md §10 for the reasoning.
#
# What this creates:
#   1. An Azure AD application (unless `application_id` points at an
#      existing one) + service principal for Cloudable to act as.
#   2. A federated identity credential trusting Cloudable's OIDC issuer AND
#      the exact per-customer subject Cloudable gave you — never the issuer
#      alone (see the warning on `var.cloudable_expected_subject`).
#   3. A single dedicated resource group.
#   4. A custom RBAC role listing only the actions Cloudable's provisioning
#      layer needs, assigned to Cloudable's service principal, scoped ONLY
#      to that resource group. Never Contributor. Never subscription scope.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
  }
}

provider "azuread" {}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

locals {
  create_application = var.application_id == null
}

# --- Identity: create a dedicated app registration, or reuse an existing one ---

resource "azuread_application" "cloudable" {
  count        = local.create_application ? 1 : 0
  display_name = "Cloudable Workload Identity"
  owners       = []
}

data "azuread_application" "existing" {
  count     = local.create_application ? 0 : 1
  client_id = var.application_id
}

locals {
  application_object_id = local.create_application ? azuread_application.cloudable[0].id : data.azuread_application.existing[0].id
  application_client_id = local.create_application ? azuread_application.cloudable[0].client_id : var.application_id
}

resource "azuread_service_principal" "cloudable" {
  client_id = local.application_client_id
}

# --- Trust: the federated identity credential Cloudable's minted tokens exchange against ---
#
# ⚠️ `subject` MUST be the exact per-customer subject Cloudable gave you.
# See the warning on `var.cloudable_expected_subject` — binding on the
# issuer alone would accept a token minted for any Cloudable customer.
resource "azuread_application_federated_identity_credential" "cloudable" {
  application_id = "/applications/${local.application_object_id}"
  display_name   = "cloudable-federation"
  description    = "Cloudable workload identity federation (invariant: subject-bound, never issuer-only). See docs/cloud-auth.md."
  audiences      = [var.federation_audience]
  issuer         = var.cloudable_issuer_url
  subject        = var.cloudable_expected_subject
}

# --- Scope: one dedicated resource group, never the whole subscription ---

resource "azurerm_resource_group" "cloudable_managed" {
  name     = var.resource_group_name
  location = var.location
}

# --- Access: a custom role listing only what a Cloudable machine's
# lifecycle actually needs (create/start/stop/reimage/archive a small VM +
# its disk/NIC/public IP) — never Contributor, never subscription scope.

resource "azurerm_role_definition" "cloudable_machine_operator" {
  name        = "Cloudable Machine Operator"
  scope       = azurerm_resource_group.cloudable_managed.id
  description = "Least-privilege role for Cloudable's provisioning agent, scoped to a single dedicated resource group. Never Contributor, never subscription scope (docs/spec.md §10)."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/start/action",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/virtualMachines/restart/action",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/write",
      "Microsoft.Compute/disks/delete",
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

  assignable_scopes = [azurerm_resource_group.cloudable_managed.id]
}

resource "azurerm_role_assignment" "cloudable_machine_operator" {
  scope              = azurerm_resource_group.cloudable_managed.id
  role_definition_id = azurerm_role_definition.cloudable_machine_operator.role_definition_resource_id
  principal_id       = azuread_service_principal.cloudable.object_id
}
