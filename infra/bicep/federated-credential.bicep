// Cloudable workload identity federation — the customer's side, Bicep
// mirror of `infra/terraform/federated-credential/`. One-click alternative
// to the Terraform module (CLAUDE.md: "Terraform is the customer-facing
// format; Bicep is the one-click alternative").
//
// Run under the customer's own credentials (`az login`) — Cloudable is
// never given credentials to run this itself (invariant #1: no cloud
// credential is ever stored, federation only). See docs/cloud-auth.md for
// the full flow and docs/spec.md §10 for the reasoning, including the
// subject-binding warning below.
//
// Managing Azure AD applications and federated identity credentials from
// ARM/Bicep is still a newer, extension-gated capability (the Microsoft
// Graph Bicep extension) that isn't uniformly available yet — the
// `azuread`/`azurerm` Terraform providers this module mirrors are the
// mature, recommended path for that half (see
// `infra/terraform/federated-credential/main.tf`). This template instead
// covers what native ARM does well — the dedicated resource group and the
// scoped custom role — paired with the two short Azure CLI commands for
// the Azure AD half, so the whole thing is still a handful of copy-paste
// commands rather than a manual portal walkthrough:
//
//   # 1. Create (or reuse) the app registration Cloudable will act as.
//   appId=$(az ad app create --display-name "Cloudable Workload Identity" \
//     --query appId -o tsv)
//   spId=$(az ad sp create --id "$appId" --query id -o tsv)
//
//   # 2. Trust Cloudable's issuer AND the exact subject it gave you.
//   # WARNING — THE SUBJECT BINDING IS THE TENANT ISOLATION BOUNDARY: a
//   # credential naming only the issuer accepts a token minted for ANY
//   # Cloudable customer (docs/spec.md §10). Never omit --subject.
//   az ad app federated-credential create --id "$appId" --parameters '{
//     "name": "cloudable-federation",
//     "issuer": "https://auth.cloudable.example",
//     "subject": "cloudable:tenant:<customer-id>",
//     "audiences": ["api://AzureADTokenExchange"]
//   }'
//
//   # 3. Deploy this template, passing the service principal's object ID.
//   az group create --name rg-cloudable-managed --location eastus
//   az deployment group create --resource-group rg-cloudable-managed \
//     --template-file infra/bicep/federated-credential.bicep \
//     --parameters servicePrincipalObjectId="$spId"

targetScope = 'resourceGroup'

@description('Object ID of the service principal created for Cloudable (see the az ad sp create command in this file\'s header comment) — NOT the application (client) ID.')
param servicePrincipalObjectId string

@description('Name of the custom RBAC role. Change only if it collides with an existing role name in this subscription.')
param roleName string = 'Cloudable Machine Operator'

// --- Access: a custom role listing only what a Cloudable machine's
// lifecycle actually needs (create/start/stop/reimage/archive a small VM +
// its disk/NIC/public IP) — never Owner/Contributor, never subscription
// scope. `targetScope = 'resourceGroup'` above means this whole template,
// including this role's `assignableScopes`, is naturally confined to the
// single resource group it's deployed into.
resource cloudableMachineOperatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, roleName)
  properties: {
    roleName: roleName
    description: 'Least-privilege role for Cloudable\'s provisioning agent, scoped to a single dedicated resource group. Never Contributor, never subscription scope (docs/spec.md §10).'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/write'
          'Microsoft.Compute/virtualMachines/delete'
          'Microsoft.Compute/virtualMachines/start/action'
          'Microsoft.Compute/virtualMachines/deallocate/action'
          'Microsoft.Compute/virtualMachines/restart/action'
          'Microsoft.Compute/disks/read'
          'Microsoft.Compute/disks/write'
          'Microsoft.Compute/disks/delete'
          'Microsoft.Network/networkInterfaces/read'
          'Microsoft.Network/networkInterfaces/write'
          'Microsoft.Network/networkInterfaces/delete'
          'Microsoft.Network/networkInterfaces/join/action'
          'Microsoft.Network/virtualNetworks/read'
          'Microsoft.Network/virtualNetworks/subnets/join/action'
          'Microsoft.Network/publicIPAddresses/read'
          'Microsoft.Network/publicIPAddresses/write'
          'Microsoft.Network/publicIPAddresses/delete'
          'Microsoft.Network/publicIPAddresses/join/action'
        ]
        notActions: []
      }
    ]
  }
}

resource cloudableMachineOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, servicePrincipalObjectId, cloudableMachineOperatorRole.id)
  properties: {
    roleDefinitionId: cloudableMachineOperatorRole.id
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
  }
}

@description('The custom RBAC role\'s resource ID.')
output roleDefinitionId string = cloudableMachineOperatorRole.id

@description('This resource group\'s resource ID — the scope Cloudable\'s access is confined to.')
output resourceGroupId string = resourceGroup().id
