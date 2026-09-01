# Cloud provider authentication

Workload identity federation to the customer's Azure subscription. No cloud credential is ever
stored (invariant 1) — Cloudable runs its own OIDC issuer, mints a short-lived, per-customer-subject
token, and the customer's Azure AD (Entra ID) validates it against a federated identity credential
they configure themselves. See `docs/spec.md` §10 for the reasoning; this file covers the
implementation.

## The flow

1. Cloudable runs an OIDC issuer at a public URL: `GET /.well-known/openid-configuration`
   (discovery document) and `GET /.well-known/jwks.json` (public signing key, JWK format).
2. At provisioning time — or on demand, via the mint endpoint below — Cloudable mints a
   short-lived (~1h) token with a **per-customer subject**: `cloudable:tenant:<customer-id>`.
3. The customer creates an app registration (or reuses one) and adds a federated identity
   credential trusting Cloudable's issuer **and that specific subject** — see
   `infra/terraform/federated-credential/` or `infra/bicep/federated-credential.bicep`.
4. Azure validates the token against that trust rule and returns an access token (~1h),
   scoped by the custom RBAC role assigned to Cloudable's service principal.

**Fully managed mode** uses a managed identity in Cloudable's own tenant instead — same
provisioning-layer code path, it does not know the difference (spec §10).

## ⚠️ The subject binding is the tenant isolation boundary

> The subject binding is the tenant isolation boundary. A trust rule naming only the issuer
> accepts a token minted for any customer. This is a single-line mistake with cross-tenant
> consequences.

Cloudable's OIDC issuer is **shared across every customer**. The `iss` claim alone proves nothing
about which tenant a token was minted for — only the `sub` claim (`cloudable:tenant:<customer-id>`)
does. A customer's federated identity credential that trusts Cloudable's issuer but leaves
`subject` unset, wildcarded, or approximate would accept a token minted for **any** Cloudable
customer, not just them. Both `infra/terraform/federated-credential/main.tf` and
`infra/bicep/federated-credential.bicep` require an exact `subject`/`cloudableExpectedSubject`
value for exactly this reason — read the warning on that variable before changing either file.

This is also this unit's canonical test:
`apps/control-plane/src/services/federation/FederationService.test.ts` mints a token for tenant
A's subject and asserts it is **rejected** by a trust rule bound to tenant B's subject, even
though both trust the same issuer.

## Endpoints

| Method | Path                               | Purpose                                              |
| :----- | :---------------------------------- | :---------------------------------------------------- |
| GET    | `/.well-known/openid-configuration` | OIDC discovery document                               |
| GET    | `/.well-known/jwks.json`            | Public signing key(s), JWK format                     |
| POST   | `/api/v1/federation/mint`           | Mint a token, attempt federation, persist + emit events |

The `.well-known/...` paths are spec-mandated OIDC convention, not versioned `/api/v1/...` routes.

### Discovery document

```
GET /.well-known/openid-configuration
```

```json
{
  "issuer": "https://auth.cloudable.example",
  "jwks_uri": "https://auth.cloudable.example/.well-known/jwks.json",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["EdDSA"]
}
```

`issuer` comes from the `FEDERATION_ISSUER_URL` config value (`apps/control-plane/src/config.ts`)
— it must be the exact, publicly reachable URL every customer's federated identity credential is
configured to trust.

### JWKS

```
GET /.well-known/jwks.json
```

```json
{ "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "...", "use": "sig", "alg": "EdDSA", "kid": "federation-oidc-v1" }] }
```

One Ed25519 key, `alg: EdDSA`. See "Signing key" below.

### Mint

Requires a real BetterAuth session (`CurrentUserAuthentication`, applied per-endpoint — see
`../apps/control-plane/src/http/routes/federation.ts`), unlike `discovery`/`jwks` above. `orgId`
comes from that session, never from the request body: this endpoint mints a real,
production-Key-Vault-signed credential and persists an `integrations` row for whatever org it's
told to, so trusting a client-supplied `orgId` here would let any caller mint a credential for,
and overwrite the stored cloud integration of, an org they don't belong to.

```
POST /api/v1/federation/mint
{
  "customerId": "acme-corp",
  "subscriptionId": "...",
  "trustRule": { "issuer": "https://auth.cloudable.example", "boundSubject": "cloudable:tenant:acme-corp" }
}
```

Success (`200`):

```json
{ "subject": "cloudable:tenant:acme-corp", "subscriptionId": "...", "token": "<jwt>" }
```

Rejection (`422`, `kind: "rejected"`, structured `reason`):

```json
{ "kind": "rejected", "error": { "code": "federation_subject_mismatch", "message": "...", "requestId": "..." }, "reason": "subject_mismatch" }
```

`trustRule` stands in for the customer's actual Azure-side configuration — no Azure account
exists in this build, so `mint` exercises the fake validator described below instead of a real
OIDC token exchange. Infra-level failures (signing, persistence) come back as a plain `500`
(`kind: "infra_error"`, no `reason`) instead.

## Token claims

| Claim | Value                                    |
| :---- | :---------------------------------------- |
| `iss` | `federationIssuerUrl` (config)            |
| `sub` | `cloudable:tenant:<customer-id>` — exact  |
| `aud` | `api://AzureADTokenExchange` (default; the fixed audience Entra ID expects for OIDC workload identity federation) |
| `iat` | mint time                                 |
| `exp` | `iat` + 1h                                |

`alg: EdDSA`, `kid: federation-oidc-v1`.

## Signing key

Reuses the `Signer` port (`apps/control-plane/src/services/Signer.ts`) that the CA/SSH-cert
signing path also uses, under its own key id (`FEDERATION_KEY_ID = "federation-oidc-v1"`) so the
two never collide. `Signer.local.ts` and `Signer.azure.ts` remain the only two files anywhere
that touch raw private key material (CLAUDE.md invariant 9) — `services/federation/jwk.ts` only
ever parses the **public** half (the SPKI DER bytes `Signer.publicKey()` already returns) into JWK
form for the JWKS endpoint, and `services/federation/jwt.ts` is pure base64url/JSON plumbing
around the port's `sign`/`publicKey` methods. No JWT library is used: `alg: EdDSA` over Ed25519 is
just "sign these exact bytes" (Ed25519 hashes internally), which is exactly what the `Signer` port
already exposes.

## The fake Azure validator — test harness, not a real integration

No Azure account exists in this build, so `services/federation/FakeAzureTrustRule.ts` simulates
the one property this unit exists to protect: does a token's `iss`/`sub` match a trust rule's
configured `issuer`/`boundSubject`? It does **not** perform real cryptographic verification against
Entra ID — the real check happens entirely inside Azure when Cloudable's provisioning layer later
exchanges the minted JWT for an access token. `FederationService.federateCredential` wires this
fake validator in as the current stand-in for that exchange (mirroring how `ProvisioningService.fake.ts`
stands in for `ProvisioningService.azure.ts` elsewhere in this codebase) purely so the tenant-isolation
property has somewhere to be exercised end-to-end, including through the HTTP mint endpoint. Swap the
one `validateAgainstTrustRule` call for a real token-exchange request once a real Azure account exists;
the persist/emit contract on either side of it does not change.

## Persistence and events

On successful (fake) validation, `federateCredential`:

- persists an `integrations` row (`kind: "cloud"`, `identifier` = the subject, `config` = `{issuer, subject, subscriptionId}`)
- emits `cloud.credential_federated` (`{subject, subscriptionId}`)

On rejection, it **always** emits `cloud.credential_rejected` (`{subject, reason}`) before failing
— never swallowed. Per `docs/events.md`, both are tier-1 (always audited) events, and rejection is
annotated as always-alert: a rejected federation attempt is a security event, not a log line.

## RBAC scope

**A custom role listing only required actions, assigned to a single dedicated resource group.
Never Contributor. Never subscription scope.** Both `infra/terraform/federated-credential/main.tf`
(`azurerm_role_definition` + `azurerm_role_assignment`) and `infra/bicep/federated-credential.bicep`
(`Microsoft.Authorization/roleDefinitions`/`roleAssignments`) define the same "Cloudable Machine
Operator" role: read/write/delete/start/stop/restart on a VM plus its disk, NIC, and public IP —
nothing else — assigned only to that one resource group.

**Certificate credentials** only where federation is impossible. **Client secrets: never.**

## Revocation

Unilateral and immediate: the customer deletes the federated identity credential (or the app
registration) on their side. Cloudable holds no credential to revoke — there is nothing on
Cloudable's side that needs to happen for access to stop.

## Running the customer-side automation

**Terraform** (the customer-facing format):

```sh
cd infra/terraform/federated-credential
terraform init
terraform validate   # never `apply` from this repo — this runs in the CUSTOMER's tenant/subscription
terraform plan \
  -var tenant_id=<customer-tenant-id> \
  -var subscription_id=<customer-subscription-id> \
  -var cloudable_issuer_url=https://auth.cloudable.example \
  -var cloudable_expected_subject=cloudable:tenant:<customer-id>
```

Outputs the application (client) ID — combined with `tenant_id` and `subscription_id`, this is
the three non-secret identifiers the customer gives Cloudable (spec §10). No secret is ever
produced.

**Bicep** (the one-click alternative): see the header comment in
`infra/bicep/federated-credential.bicep` for the exact `az` commands — two short `az ad`
commands for the app registration + federated credential, then one `az deployment group create`
for the resource group's custom role. (Managing Azure AD resources directly from ARM/Bicep is
still an extension-gated capability that isn't uniformly available yet; the `azuread`/`azurerm`
Terraform provider is the mature path for that half, which is why Terraform — not Bicep — is the
primary customer-facing format per `CLAUDE.md`.)

## Related

- `docs/spec.md` §10 — the reasoning behind every decision here.
- `docs/events.md` — `cloud.credential_federated`/`cloud.credential_rejected` in the full catalogue.
- `apps/control-plane/src/services/Signer.ts` — the signing port this unit reuses.
- `apps/control-plane/src/services/federation/` — the implementation.
