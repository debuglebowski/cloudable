# Cloudable — the Entra application the console federates against for SSO.
#
# Deliberately a SEPARATE module from `control-plane`, not a flag on it, because the
# two live on opposite sides of an Azure permission boundary. `control-plane` builds
# subscription resources and needs only subscription RBAC. This builds a DIRECTORY
# object, which subscription roles grant nothing over: whoever applies it needs a
# Microsoft Graph permission or an Entra role, and the only ones that cover the job
# (`Application.ReadWrite.OwnedBy`, or the Application Administrator role) are
# tenant-wide over app registrations.
#
# Keeping it separate means an unattended CI identity never has to hold that. The
# expected shape is: a person applies this once, by hand, and feeds its
# `federation_metadata_url` into `control-plane`'s `idp_metadata_url` as a plain
# value. Its own state should be separate too, so the pipeline that deploys the
# control plane holds no credentials for it.
#
# Not using SSO at all? Don't call this. `control-plane` defaults `idp_metadata_url`
# to null and leaves the console in charge. Already have an Entra app? Don't call this
# either — pass your existing app's metadata URL straight to `control-plane`. This
# module exists only so that the common case is describable in code rather than in
# someone's memory of which portal blades they clicked.
#
# Azuread-only on purpose: no `azurerm` provider, no subscription dependency of any
# kind. Exporting Entra's audit log (`azurerm_monitor_aad_diagnostic_setting`) is the
# caller's business, since only the caller knows which workspace it keeps evidence in.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 3.0"
    }
  }
}

data "azuread_client_config" "current" {}

locals {
  # Must match `spIssuer()` in the control plane (services/IdpSsoService.ts): Entra
  # puts this in every assertion's Audience and the SP rejects anything else.
  entity_id = "${var.console_origin}/api/auth/sso/saml2/sp/metadata"

  # The Reply URL (assertion consumer service). @better-auth/sso routes ACS per
  # provider, and `control-plane` fixes the provider id whenever `idp_metadata_url`
  # is set, which is what makes this URL knowable before anything is connected.
  reply_url = "${var.console_origin}/api/auth/sso/saml2/sp/acs/${var.sso_provider_id}"

  # Whoever applies this, unless told otherwise. An application with no owner can be
  # read back only by a tenant-wide admin, so the next `plan` fails for the very
  # identity that created it.
  owners = var.owners != null ? var.owners : [data.azuread_client_config.current.object_id]
}

resource "azuread_application" "console_sso" {
  display_name = var.display_name

  # Single tenant. This application authenticates one organisation's own people;
  # there is no scenario where another directory should sign in to it.
  sign_in_audience = "AzureADMyOrg"

  identifier_uris = [local.entity_id]
  owners          = local.owners

  web {
    redirect_uris = [local.reply_url]
  }
}

resource "azuread_service_principal" "console_sso" {
  client_id = azuread_application.console_sso.client_id
  owners    = local.owners

  # What makes this an SSO enterprise application rather than a bare app
  # registration: without it the SAML blade is not offered in the portal and no
  # federation metadata document is published.
  preferred_single_sign_on_mode = "saml"

  feature_tags {
    enterprise = true
    gallery    = false
  }
}

# The certificate Entra signs assertions with. Terraform never sees the private half:
# this resource exports only the public certificate, its thumbprint and key id. There
# is no private_key attribute on it at all, so nothing sensitive reaches state.
resource "azuread_service_principal_token_signing_certificate" "console_sso" {
  service_principal_id = azuread_service_principal.console_sso.id
  display_name         = var.signing_certificate_subject
}
