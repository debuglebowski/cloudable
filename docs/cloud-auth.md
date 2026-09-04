# Cloud provider authentication

**Self-hosted mode is the real, shipped path.** The control plane manages machines in its
**own** Azure tenant/subscription, via its **own** managed identity — never a customer's,
never federation. `ProvisioningService.azure.ts` calls `DefaultAzureCredential()` (an Azure
Container App's managed identity in production, `az login` locally) against exactly one
subscription, resource group, and subnet: `AZURE_SUBSCRIPTION_ID` /
`AZURE_MACHINES_RESOURCE_GROUP` / `AZURE_MACHINES_SUBNET_ID` (`apps/control-plane/src/
config.ts`), all set once for the whole deployment by `infra/terraform/control-plane`. There is
only ever one credential; `desc.orgId` on a provisioning call is used only to tag the resulting
Azure resources, never to pick which tenant/subscription to act against.

This still satisfies invariant #1 ("no cloud credential is ever stored, federation only, never
client secrets") — a managed identity has no credential to store at all; it's ambient, resolved
by the Azure platform itself at call time.

**Enabling Azure for an org is therefore a plain policy toggle, not a connection.** The
Integrations page's "Cloud provider" section (`docs/frontend.md`) lets an org turn Azure,
Docker, or Fake on or off — several can be enabled at once, since a machine now picks one
per-creation from whatever the org has enabled. There is nothing to fill in for any of the
three: no tenant ID, no application ID, no subscription ID. `GET /api/v1/provisioning/
capabilities` reports whether Azure is even *available* on this deployment at all (i.e. whether
the three env vars above are set) — enabling it is refused client-side when it isn't.

## The customer-federated (BYOC) path — not implemented

An **earlier design** for this unit described per-customer OIDC federation: Cloudable running
its own OIDC issuer, minting a short-lived token with a per-customer subject
(`cloudable:tenant:<customer-id>`), and a customer's own Azure AD trusting that issuer+subject
via a federated identity credential they configure — the classic "Cloudable-hosted control
plane manages many customers' separate Azure tenants" shape. **This is not what shipped.** The
strategic pivot to open-source, self-hosted-only distribution (`CLAUDE.md`) made the
self-managed-identity path above the only one worth building for v1 — there is no
Cloudable-hosted control plane for a federated identity to matter to.

The plumbing for it still exists and still works in isolation — it just isn't wired into real
machine provisioning:

- `GET /.well-known/openid-configuration` / `GET /.well-known/jwks.json` — a real OIDC issuer
  (`FEDERATION_ISSUER_URL`, `Signer`/`services/federation/jwt.ts`), Ed25519-signed.
- `POST /api/v1/federation/mint` — mints a token and validates it against a trust rule, but
  through `FakeAzureTrustRule.ts` (a stand-in for a real Azure token exchange, which nothing in
  this build performs) — see that file's own doc comment.
- `docs/events.md`'s `cloud.credential_federated`/`cloud.credential_rejected` events, and the
  `integrations` table's original `kind: "cloud"` config shape (`{tenantId, applicationId,
  subscriptionId}`) — superseded on the console side, but the shape these events describe was
  never deleted from the schema.

Reviving this as a real feature (letting a Cloudable-hosted control plane manage a customer's
own tenant) would mean: a real Azure AD token exchange in place of `FakeAzureTrustRule`,
`ProvisioningService.azure.ts` picking a credential per-org instead of one ambient identity, and
the Integrations page's Azure card growing a real connect form again instead of a fieldless
"Enable." None of that is scoped or planned — this section exists so the dormant code isn't
mistaken for a security gap or misread as the primary story.

## RBAC scope (real, used by the self-hosted path too)

**A custom role listing only required actions, assigned to a single dedicated resource group.
Never Contributor. Never subscription scope.** `infra/terraform/control-plane/main.tf` (when
`enable_self_managed_machines = true`, the default) creates the resource group, subnet, and
deny-all-inbound NSG the control plane's machines live in, and grants its own managed identity
the "Cloudable Machine Operator" role scoped to just that resource group — read/write/delete/
start/stop/restart on a VM plus its disk, NIC, and public IP, nothing else. The sibling
`infra/terraform/federated-credential/` module defines the same role for the (currently unused)
BYOC path above, kept in sync by hand — see that main.tf's own comment.

**Certificate credentials** only where federation is impossible. **Client secrets: never.**

## Revocation

For the real (self-hosted) path: revoking the control plane's own managed identity, or removing
the RBAC role assignment, in the customer's own tenant — ordinary Azure AD administration, not a
Cloudable-specific flow, since there's no Cloudable-side credential to revoke either way.

## Related

- `docs/events.md` — `cloud.credential_federated`/`cloud.credential_rejected` (BYOC path only —
  see above).
- `apps/control-plane/src/services/Signer.ts` — the signing port the (unused) OIDC issuer reuses.
- `apps/control-plane/src/services/CloudCatalogService.ts` — syncs the org-facing Azure region
  catalog from the real ARM `SubscriptionClient`, using the same ambient managed identity.
- `apps/control-plane/src/services/federation/` — the BYOC implementation described above.
