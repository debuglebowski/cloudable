// Cloudable — self-hosted control plane deploy (Bicep, the one-click alternative
// to infra/terraform/control-plane/ — docs/spec.md §25).
//
// This is for self-hosters only. Provisions a resource group, ONE stateless
// container (the control plane) plus a managed PostgreSQL instance, in the
// customer's own Azure tenant. Self-hosted is the simplest deployment mode
// (docs/spec.md §2): one trust boundary, managed identity, no federation —
// nothing further to configure on the Cloudable side. Contrast with
// infra/bicep/federated-credential.bicep (a separate unit's file), which is the
// BYOC artefact a customer runs to let a Cloudable-hosted control plane manage
// machines in their tenant.
//
// This file is deployed at SUBSCRIPTION scope, mirroring
// infra/terraform/control-plane/ (which creates its own resource group rather
// than adopting an existing one) — it creates the resource group itself, then
// hands off to control-plane.resources.bicep (a module, resource-group scoped)
// for everything inside it.
//
// Deploy:
//
//   az deployment sub create \
//     --location westeurope \
//     --template-file infra/bicep/control-plane.bicep \
//     --parameters postgresAdminPassword=<a strong password> \
//                  betterAuthSecret=$(openssl rand -base64 32)
//
// Validate without deploying (what this build's PR verification used, since no
// real Azure account exists here):
//
//   az bicep build --file infra/bicep/control-plane.bicep
//   az deployment sub validate \
//     --location westeurope \
//     --template-file infra/bicep/control-plane.bicep \
//     --parameters postgresAdminPassword=<dummy> betterAuthSecret=<dummy>
//
// The control-plane image is built from apps/control-plane/Dockerfile and
// published by .github/workflows/rebuild-base-image.yml to
// ghcr.io/debuglebowski/cloudable/control-plane (private — pass
// controlPlaneImageRegistryUsername/Password, e.g. a GitHub PAT with
// read:packages, or build and push your own to a registry you control).

targetScope = 'subscription'

@description('Azure region for every resource this template creates.')
param location string = deployment().location

@description('Name of the resource group this template creates and deploys into. It does not adopt an existing group.')
param resourceGroupName string = 'cloudable-control-plane'

@description('Short prefix used to derive resource names. Keep it short, lowercase alphanumeric and hyphens.')
param namePrefix string = 'cloudable'

@description('Container image reference for the control plane, without tag (e.g. "ghcr.io/debuglebowski/cloudable/control-plane", the path rebuild-base-image.yml actually publishes to).')
param controlPlaneImage string = 'ghcr.io/debuglebowski/cloudable/control-plane'

@description('''
Tag to deploy. Defaults to "main", the tag rebuild-base-image.yml moves on every
push to main — "latest" is never pushed by that workflow, so it is not a usable
default here.

Cloudable's own production deploys (`cloudable-deploy`, a separate private repo per
docs/spec.md §26) pin by image *digest* rather than tag, because a tag can be
repointed upstream and "what is running right now" needs to stay answerable. That
pinning discipline is out of scope for this self-host template — move to a pinned
digest yourself once you have a release process, by setting controlPlaneImage to
"<repo>@sha256:<digest>" (this tag parameter is then ignored).
''')
param controlPlaneImageTag string = 'main'

@description('Registry hostname the control-plane image is pulled from. Only used when controlPlaneImageRegistryPassword is set.')
param controlPlaneImageRegistryServer string = 'ghcr.io'

@description('Registry username for pulling controlPlaneImage, if it is private. For GHCR this is any GitHub username with read:packages on the image.')
param controlPlaneImageRegistryUsername string = ''

@description('Registry password/PAT for pulling controlPlaneImage, if it is private (ghcr.io/debuglebowski/cloudable/control-plane is private by default — a GitHub PAT with read:packages works). Leave empty for a public image.')
@secure()
param controlPlaneImageRegistryPassword string = ''

@description('vCPU allocated to the control plane container (Container Apps billing unit).')
param containerCpu string = '0.5'

@description('Memory allocated to the control plane container.')
param containerMemory string = '1Gi'

@description('Minimum Container App replica count. 1 keeps the control plane always warm; set to 0 to scale to zero when idle.')
param minReplicas int = 1

@description('Maximum Container App replica count.')
param maxReplicas int = 3

@description('Azure Database for PostgreSQL Flexible Server SKU name.')
param postgresSkuName string = 'Standard_B1ms'

@description('Postgres Flexible Server SKU tier.')
param postgresSkuTier string = 'Burstable'

@description('PostgreSQL major version.')
param postgresVersion string = '16'

@description('Postgres Flexible Server storage size in GB.')
param postgresStorageGb int = 32

@description('Administrator login for the Postgres Flexible Server.')
param postgresAdminUsername string = 'cloudable'

@description('Administrator password for the Postgres Flexible Server. Generate a strong random value and pass it at deploy time — never commit it.')
@secure()
param postgresAdminPassword string

@description('Name of the application database created on the Postgres server.')
param postgresDatabaseName string = 'cloudable'

@description('Secret used by BetterAuth to sign sessions (BETTER_AUTH_SECRET). Generate with e.g. `openssl rand -base64 32` and pass at deploy time.')
@secure()
param betterAuthSecret string

@description('Port the control plane HTTP server listens on inside the container (PORT env var).')
param port int = 3000

@description('Tags applied to every resource this template creates.')
param tags object = {
  project: 'cloudable'
  mode: 'self-hosted'
}

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources 'control-plane.resources.bicep' = {
  name: 'cloudable-control-plane-resources'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    controlPlaneImage: controlPlaneImage
    controlPlaneImageTag: controlPlaneImageTag
    controlPlaneImageRegistryServer: controlPlaneImageRegistryServer
    controlPlaneImageRegistryUsername: controlPlaneImageRegistryUsername
    controlPlaneImageRegistryPassword: controlPlaneImageRegistryPassword
    containerCpu: containerCpu
    containerMemory: containerMemory
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    postgresSkuName: postgresSkuName
    postgresSkuTier: postgresSkuTier
    postgresVersion: postgresVersion
    postgresStorageGb: postgresStorageGb
    postgresAdminUsername: postgresAdminUsername
    postgresAdminPassword: postgresAdminPassword
    postgresDatabaseName: postgresDatabaseName
    betterAuthSecret: betterAuthSecret
    port: port
    tags: tags
  }
}

@description('Public HTTPS URL of the deployed control plane.')
output controlPlaneUrl string = resources.outputs.controlPlaneUrl

@description('Resource group holding every resource this template created.')
output resourceGroupName string = rg.name

@description('Fully-qualified domain name of the provisioned PostgreSQL Flexible Server.')
output postgresServerFqdn string = resources.outputs.postgresServerFqdn

@description('Name of the deployed Container App running the control plane.')
output containerAppName string = resources.outputs.containerAppName

@description('Principal ID of the control plane\'s system-assigned managed identity, for granting it access to other Azure resources (e.g. Key Vault) if desired.')
output containerAppIdentityPrincipalId string = resources.outputs.containerAppIdentityPrincipalId
