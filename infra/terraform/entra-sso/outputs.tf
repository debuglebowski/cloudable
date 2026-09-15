output "federation_metadata_url" {
  description = "Pass this to the control-plane module's idp_metadata_url. Derived from the application that actually exists rather than copied out of a portal blade, so it cannot drift from it. Not sensitive: it is a public document describing how to verify Entra's assertions."
  value       = "https://login.microsoftonline.com/${data.azuread_client_config.current.tenant_id}/federationmetadata/2007-06/federationmetadata.xml?appid=${azuread_application.console_sso.client_id}"
}

output "client_id" {
  description = "The application's client id. Names the application; does not authenticate anyone as it."
  value       = azuread_application.console_sso.client_id
}

output "entity_id" {
  description = "The SAML entityID registered with Entra. Should equal the control plane's own spIssuer() — a mismatch means every assertion is rejected on Audience."
  value       = local.entity_id
}

output "reply_url" {
  description = "The Reply URL (assertion consumer service) registered with Entra. Should end in sso_provider_id; a mismatch means this module and the control plane disagree about the provider id."
  value       = local.reply_url
}

output "signing_certificate_thumbprint" {
  description = "Thumbprint of the certificate Entra signs assertions with, for checking against what the control plane fetched."
  value       = azuread_service_principal_token_signing_certificate.console_sso.thumbprint
}
