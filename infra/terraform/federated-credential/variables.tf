# The customer's side of workload identity federation (docs/spec.md §10,
# docs/cloud-auth.md). Running this module with `apply` is the "customer
# creates an app registration and adds a federated credential trusting that
# issuer and that specific subject" step from the spec — Cloudable never
# runs this itself, and never holds these providers' credentials (invariant
# #1: no cloud credential is ever stored, federation only).

variable "tenant_id" {
  description = "The customer's Azure AD (Entra ID) tenant ID. One of the three non-secret identifiers the customer gives Cloudable (docs/spec.md §10) — Cloudable never sees a credential, only this ID."
  type        = string
}

variable "subscription_id" {
  description = "The customer's Azure subscription ID. One of the three non-secret identifiers the customer gives Cloudable — also the scope the dedicated resource group and custom role are created in."
  type        = string
}

variable "application_id" {
  description = <<-EOT
    Optional: an existing Azure AD application (client) ID to attach the
    federated credential to. Leave unset (null) to have this module create
    a new, dedicated app registration for Cloudable instead — the
    recommended default, since it keeps Cloudable's access isolated to its
    own identity rather than piggybacking on one used for other purposes.

    Whichever identity is used, its (client) ID is the third of the three
    non-secret identifiers the customer gives Cloudable (docs/spec.md §10).
  EOT
  type        = string
  default     = null
}

variable "location" {
  description = "Azure region for the dedicated resource group Cloudable's machines are provisioned into."
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Name of the single, dedicated resource group Cloudable's custom role is scoped to. Never grant Cloudable subscription-scoped access (docs/spec.md §10)."
  type        = string
  default     = "rg-cloudable-managed"
}

variable "cloudable_issuer_url" {
  description = <<-EOT
    Cloudable's OIDC issuer URL, e.g. https://auth.cloudable.example — the
    exact `issuer` value from `GET {this}/.well-known/openid-configuration`.
    This is what the federated identity credential's `issuer` argument
    trusts; Cloudable will present JWTs whose `iss` claim equals this URL.
  EOT
  type        = string
}

variable "cloudable_expected_subject" {
  description = <<-EOT
    The exact subject Cloudable will present when federating on this
    customer's behalf, in the form `cloudable:tenant:<customer-id>` (see
    docs/spec.md §10 and docs/cloud-auth.md).

    ⚠️ THE SUBJECT BINDING IS THE TENANT ISOLATION BOUNDARY. A federated
    identity credential that trusts only `cloudable_issuer_url` and leaves
    `subject` unset (or wildcarded) would accept a token minted for ANY
    Cloudable customer, not just this one — Cloudable's issuer is shared
    across all its customers, so the issuer alone proves nothing about
    which tenant a token was minted for. This is a single-line mistake with
    cross-tenant consequences. Always set this to the exact subject
    Cloudable gave you for this account; never leave it blank.
  EOT
  type        = string
}

variable "federation_audience" {
  description = "The `aud` claim Cloudable's minted tokens carry. Defaults to the fixed audience Entra ID expects for OIDC workload identity federation — leave this unless Cloudable tells you otherwise."
  type        = string
  default     = "api://AzureADTokenExchange"
}
