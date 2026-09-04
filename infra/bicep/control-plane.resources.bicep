// Cloudable — self-hosted control plane, resource-group-scoped resources.
//
// Deployed by control-plane.bicep (the subscription-scoped entry point, which
// creates the resource group and invokes this as a module). Not meant to be
// deployed directly — see control-plane.bicep for the customer-facing entry
// point, prerequisites and commands.

@description('Azure region for every resource this template creates.')
param location string

@description('Short prefix used to derive resource names. Keep it short, lowercase alphanumeric and hyphens.')
param namePrefix string

@description('Container image reference for the control plane, without tag (e.g. "ghcr.io/debuglebowski/cloudable-control-plane"), OR a fully digest-pinned reference ("<repo>@sha256:<digest>") — see controlPlaneImageTag.')
param controlPlaneImage string

@description('Tag to deploy. Ignored when controlPlaneImage already carries an "@sha256:" digest.')
param controlPlaneImageTag string

@description('Registry hostname the control-plane image is pulled from. Only used when controlPlaneImageRegistryPassword is set.')
param controlPlaneImageRegistryServer string

@description('Registry username for pulling controlPlaneImage, if it is private.')
param controlPlaneImageRegistryUsername string

@description('Registry password/PAT for pulling controlPlaneImage, if it is private. Leave empty for a public image.')
@secure()
param controlPlaneImageRegistryPassword string

@description('vCPU allocated to the control plane container (Container Apps billing unit).')
param containerCpu string

@description('Memory allocated to the control plane container.')
param containerMemory string

@description('Minimum Container App replica count.')
param minReplicas int

@description('Maximum Container App replica count.')
param maxReplicas int

@description('Azure Database for PostgreSQL Flexible Server SKU name.')
param postgresSkuName string

@description('Postgres Flexible Server SKU tier.')
param postgresSkuTier string

@description('PostgreSQL major version.')
param postgresVersion string

@description('Postgres Flexible Server storage size in GB.')
param postgresStorageGb int

@description('Administrator login for the Postgres Flexible Server.')
param postgresAdminUsername string

@description('Administrator password for the Postgres Flexible Server.')
@secure()
param postgresAdminPassword string

@description('Name of the application database created on the Postgres server.')
param postgresDatabaseName string

@description('Secret used by BetterAuth to sign sessions (BETTER_AUTH_SECRET).')
@secure()
param betterAuthSecret string

@description('Port the control plane HTTP server listens on inside the container (PORT env var).')
param port int

@description('Tags applied to every resource this template creates.')
param tags object

var postgresSuffix = uniqueString(resourceGroup().id)
var postgresServerName = '${namePrefix}-pg-${postgresSuffix}'
var appName = '${namePrefix}-cp'
// If controlPlaneImage already carries a digest ("<repo>@sha256:<digest>"),
// don't also append a tag — "<repo>@sha256:<digest>:<tag>" is not a valid
// image reference.
var containerImage = contains(controlPlaneImage, '@sha256:') ? controlPlaneImage : '${controlPlaneImage}:${controlPlaneImageTag}'
var usesPrivateRegistry = !empty(controlPlaneImageRegistryPassword)
// uriComponent both credential parts: a generated password commonly contains
// URI-reserved characters (/, +, =, @, ...) that would otherwise break
// connection-string parsing in the `postgres` client / drizzle-orm.
var databaseUrl = 'postgres://${uriComponent(postgresAdminUsername)}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${postgresDatabaseName}?sslmode=require'
// Azure Container Apps assigns a predictable FQDN of
// "<app-name>.<environment-default-domain>" — the environment's default domain is
// known once the Container Apps Environment exists, so this avoids a
// self-referential dependency on the app's own (not-yet-created) ingress FQDN.
var publicUrl = 'https://${appName}.${containerAppEnvironment.properties.defaultDomain}'

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: postgresAdminUsername
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: postgresStorageGb
    }
    // Self-host is a single-trust-boundary deployment (docs/spec.md §2) — no
    // VNet peering or private endpoint plumbing. Reachability to the control
    // plane's Container App is granted via the "allow Azure services" firewall
    // rule below, not network isolation. Harden this yourself if your
    // compliance posture requires it.
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgres
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Special start/end 0.0.0.0 range: Azure's documented mechanism to let the
// Container App reach this server without a static IP to allow-list. Note
// this is broader than "just this deployment" — per Microsoft's own docs it
// allows connections from IP addresses allocated to ANY Azure service,
// including other customers' subscriptions, not only this template's
// Container App. That's a deliberate simplification for a one-shot self-host
// template; harden with VNet integration / private endpoints yourself if your
// compliance posture requires it.
resource postgresFirewallAllowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-cp-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource containerAppEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-cp-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource controlPlane 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  // System-assigned managed identity. Self-hosted mode has no federation
  // (docs/spec.md §2/§10) — that's a BYOC-only concern
  // (infra/bicep/federated-credential.bicep). This identity exists so the control
  // plane can authenticate to other Azure resources in the same tenant (e.g. Key
  // Vault, if a self-hoster later moves secrets there) without ever holding a
  // stored credential (invariant 1) — nothing is granted to it by this template
  // today.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerAppEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
      }
      secrets: concat(
        [
          {
            name: 'database-url'
            value: databaseUrl
          }
          {
            name: 'better-auth-secret'
            value: betterAuthSecret
          }
        ],
        usesPrivateRegistry
          ? [
              {
                name: 'registry-password'
                value: controlPlaneImageRegistryPassword
              }
            ]
          : []
      )
      registries: usesPrivateRegistry
        ? [
            {
              server: controlPlaneImageRegistryServer
              username: controlPlaneImageRegistryUsername
              passwordSecretRef: 'registry-password'
            }
          ]
        : []
    }
    template: {
      containers: [
        {
          name: 'control-plane'
          image: containerImage
          resources: {
            cpu: json(containerCpu)
            memory: containerMemory
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'BETTER_AUTH_SECRET'
              secretRef: 'better-auth-secret'
            }
            {
              name: 'BETTER_AUTH_URL'
              value: publicUrl
            }
            {
              name: 'PORT'
              value: string(port)
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  dependsOn: [
    postgresDatabase
    postgresFirewallAllowAzureServices
  ]
}

@description('Public HTTPS URL of the deployed control plane.')
output controlPlaneUrl string = publicUrl

@description('Fully-qualified domain name of the provisioned PostgreSQL Flexible Server.')
output postgresServerFqdn string = postgres.properties.fullyQualifiedDomainName

@description('Name of the deployed Container App running the control plane.')
output containerAppName string = controlPlane.name

@description('Principal ID of the control plane\'s system-assigned managed identity, for granting it access to other Azure resources (e.g. Key Vault) if desired.')
output containerAppIdentityPrincipalId string = controlPlane.identity.principalId
