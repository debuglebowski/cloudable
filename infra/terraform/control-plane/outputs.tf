output "control_plane_url" {
  description = "Public HTTPS URL of the deployed control plane."
  value       = local.public_url
}

output "resource_group_name" {
  description = "Resource group holding every resource this module created."
  value       = azurerm_resource_group.this.name
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
