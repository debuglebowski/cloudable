output "control_plane_url" {
  description = "Public HTTPS URL of the deployed control plane."
  value       = local.public_url
}

output "resource_group_name" {
  description = "Resource group holding every resource this module created."
  value       = local.resource_group_name
}

output "postgres_server_fqdn" {
  description = "Fully-qualified domain name of the provisioned PostgreSQL Flexible Server."
  value       = azurerm_postgresql_flexible_server.this.fqdn
}

output "container_app_name" {
  description = "Name of the deployed Container App running the control plane."
  value       = azurerm_container_app.this.name
}

output "container_app_identity_principal_id" {
  description = "Principal ID of the control plane's system-assigned managed identity, for granting it access to other Azure resources (e.g. Key Vault) if desired."
  value       = azurerm_container_app.this.identity[0].principal_id
}

output "machines_resource_group_name" {
  description = "Resource group real Azure machines are provisioned into. Null when enable_self_managed_machines is false."
  value       = local.machines_resource_group_name
}

output "machines_subnet_id" {
  description = "Full ARM resource id of the subnet ProvisioningService.azure.ts joins new machines' NICs to. Null when enable_self_managed_machines is false."
  value       = var.enable_self_managed_machines ? azurerm_subnet.machines[0].id : null
}

# The three outputs below exist for a root config that wants to bind a real
# custom domain itself (see README.md's recipe) — this module deliberately
# doesn't do that binding, since it varies by DNS provider and needs azurerm
# v4 (this module targets v3+ generically). They're generically useful for
# any downstream customization, not specific to custom domains.

output "container_app_id" {
  description = "Full ARM resource id of the Container App running the control plane."
  value       = azurerm_container_app.this.id
}

output "container_app_environment_id" {
  description = "Full ARM resource id of the Container Apps Environment the control plane runs in."
  value       = azurerm_container_app_environment.this.id
}

output "custom_domain_verification_id" {
  description = "The Container App's domain-ownership verification token — Azure requires a TXT record at \"asuid.<your domain>\" containing this value before it will bind a custom hostname."
  value       = azurerm_container_app.this.custom_domain_verification_id
  sensitive   = true
}

output "app_identity_name" {
  description = "Name of the user-assigned managed identity the control plane runs as (null unless key_vault_id is set). This is the exact name the Postgres role must be created with under Entra auth: `SELECT * FROM pgaadauth_create_principal('<this>', false, false)`."
  value       = local.use_key_vault ? azurerm_user_assigned_identity.app[0].name : null
}

output "app_identity_principal_id" {
  description = "Principal (object) id of the user-assigned managed identity, for granting it access to resources outside this module. Null unless key_vault_id is set — with a system-assigned identity, use container_app_identity_principal_id instead."
  value       = local.use_key_vault ? azurerm_user_assigned_identity.app[0].principal_id : null
}

output "key_vault_secret_spec" {
  description = <<-EOT
    How to generate the Key Vault secrets this module expects, as
    name -> { bytes, encoding, chars }.

    NOT sensitive: this describes how the values are produced, never what
    they are. Nothing here is derived from a secret value, and this module
    never reads one.

    Consumed by `scripts/seed-vault-secrets.sh`, so the names, lengths and
    encoding have exactly one definition. Adding a fifth secret is then a
    one-line change to local.key_vault_secret_specs that both the Container
    App wiring and the seeding script pick up — which is the difference
    between "generation is declared in code" and "the rules are written down
    twice, in two languages, and drift".

    Null unless enable_key_vault is set.
  EOT
  value = local.use_key_vault ? {
    for name, spec in local.key_vault_secret_specs : name => {
      bytes    = spec.bytes
      encoding = "base64url"
      # base64url of B bytes, unpadded: exactly ceil(B*8/6) characters.
      chars = ceil(spec.bytes * 8 / 6)
    }
  } : null
}

output "idp_metadata_url" {
  description = <<-EOT
    The SAML federation metadata URL this deployment is configured against,
    echoed back, or null when the identity provider is connected through the
    console instead.

    Not sensitive: a federation metadata document is public by design — it
    describes how to verify the identity provider's assertions and contains no
    secret.
  EOT
  value       = var.idp_metadata_url
}

output "sso_provider_id" {
  description = <<-EOT
    The SAML provider id this deployment uses when idp_metadata_url is set —
    a fixed constant, matching CONFIGURED_IDP_PROVIDER_ID in the control
    plane's config.ts.

    Exported so a calling config can build the identity provider's Reply URL
    (assertion consumer endpoint, ".../sso/saml2/sp/acs/<id>") without
    hardcoding the same string twice. Null when no identity provider is
    configured, since a console-connected one gets a generated id that does
    not exist until someone connects it.
  EOT
  value       = var.idp_metadata_url != null ? "configured" : null
}
