output "application_id" {
  description = "The Azure AD application (client) ID — give this to Cloudable along with tenant_id and subscription_id (the three non-secret identifiers from docs/spec.md §10). No secret is ever produced by this module."
  value       = local.application_client_id
}

output "service_principal_object_id" {
  description = "Object ID of the service principal Cloudable's federated credential authenticates as."
  value       = azuread_service_principal.cloudable.object_id
}

output "resource_group_id" {
  description = "The dedicated resource group Cloudable's custom role is scoped to."
  value       = azurerm_resource_group.cloudable_managed.id
}

output "role_definition_id" {
  description = "The custom RBAC role's resource ID."
  value       = azurerm_role_definition.cloudable_machine_operator.role_definition_resource_id
}
