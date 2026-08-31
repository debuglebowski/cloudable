# Cloudable workload identity federation — the customer's side (Terraform)

**This is for BYOC and fully-managed customers.** This is the artefact you run to
federate your own Azure AD tenant so a Cloudable-hosted control plane can manage
machines in it, without Cloudable ever holding a credential (invariant #1: no cloud
credential is ever stored, federation only). If you're self-hosting the control plane
yourself instead, you don't need this — see `infra/terraform/control-plane/` (one
Azure tenant, one system-assigned managed identity, no federation).

Run this under **your own** Azure credentials (`az login` against your own tenant),
never Cloudable's — Cloudable never runs this itself and never holds the
`azuread`/`azurerm` providers' credentials. See `docs/cloud-auth.md` for the full flow
and `docs/spec.md` §10 for the reasoning. This module provisions:

- An Azure AD application (unless `application_id` points at an existing one) +
  service principal for Cloudable to act as
- A federated identity credential trusting Cloudable's OIDC issuer **and** the exact
  per-customer subject Cloudable gave you — never the issuer alone (see the warning on
  `var.cloudable_expected_subject`: this binding is the tenant isolation boundary)
- A single dedicated resource group
- A custom RBAC role listing only the actions Cloudable's provisioning layer needs
  (create/start/stop/reimage/archive a machine's VM + its disk/NIC/public IP),
  assigned to Cloudable's service principal, scoped **only** to that resource group.
  Never Contributor. Never subscription scope.

The equivalent one-click template is `infra/bicep/federated-credential.bicep` — it
covers the resource group and custom role natively, paired with two short `az` CLI
commands for the Azure AD half (app registration + federated credential), since
managing those resource types from ARM/Bicep isn't uniformly available yet. See that
file's own header comment for the exact commands.

## Prerequisites

- Your own Azure account, with `az login` already run against your own tenant (or
  another way to authenticate the `azuread`/`azurerm` providers — see the
  [azurerm provider auth docs][azurerm-auth])
- Terraform >= 1.5, or [OpenTofu](https://opentofu.org/) (this HCL works with either)
- Enough Azure AD privilege to create an app registration + service principal (e.g.
  Application Developer or Cloud Application Administrator), and enough subscription
  privilege to create a resource group, a custom role definition, and a role
  assignment scoped to it
- Two values only Cloudable can give you — `cloudable_issuer_url` (Cloudable's OIDC
  issuer URL) and `cloudable_expected_subject` (your exact per-customer subject, in
  the form `cloudable:tenant:<customer-id>`) — see `docs/cloud-auth.md`

[azurerm-auth]: https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_client_secret

## Commands

```bash
cd infra/terraform/federated-credential

terraform init

# Required: tenant_id, subscription_id (your own — see docs/spec.md §10), plus the
# two values Cloudable gave you, cloudable_issuer_url and cloudable_expected_subject.
# None of these four are secrets, but pass them however you prefer (-var, a *.tfvars
# file, or TF_VAR_* env vars).
terraform plan \
  -var="tenant_id=<your Azure AD tenant id>" \
  -var="subscription_id=<your Azure subscription id>" \
  -var="cloudable_issuer_url=<issuer URL Cloudable gave you>" \
  -var="cloudable_expected_subject=<subject Cloudable gave you>"

terraform apply \
  -var="tenant_id=<your Azure AD tenant id>" \
  -var="subscription_id=<your Azure subscription id>" \
  -var="cloudable_issuer_url=<issuer URL Cloudable gave you>" \
  -var="cloudable_expected_subject=<subject Cloudable gave you>"
```

After `apply`, give Cloudable the three non-secret identifiers it needs (`docs/spec.md`
§10): the `tenant_id` and `subscription_id` you passed in, plus the `application_id`
output. No secret is ever produced by this module — there is nothing else to hand over.

To revoke Cloudable's access at any time: delete the federated identity credential
(unilateral, immediate — `docs/spec.md` §10 "Revocation"), or `terraform destroy` with
the same variables to tear everything down.

## Verifying this template without an Azure account

Unlike `infra/terraform/control-plane/`, this directory has no committed dummy
`*.tfvars` for offline `terraform plan`. `terraform validate` needs no variable values
and no provider credentials — it's a pure syntax/type check, and it passes with no
Azure account at all, same as for `control-plane`. But `terraform plan` and `apply`
are a different story here: this module's whole job is calling the `azuread` and
`azurerm` provider APIs against a **real** tenant — creating (or looking up) an app
registration, its service principal, and a resource group/role/role-assignment in a
real subscription — so, unlike `control-plane`'s Postgres + Container App module,
there's no meaningful way to `plan` this one with fabricated values and no backing
Azure account. Fully validating this module beyond `terraform validate` requires a real
customer Azure AD tenant and subscription to point it at.

## Notes

- `application_id` defaults to `null`, which has this module create a new, dedicated
  app registration for Cloudable. Only set it to attach the federated credential to an
  app registration you already have — that keeps Cloudable's access isolated to its
  own identity by default, rather than piggybacking on one used for other purposes.
- `cloudable_expected_subject` is the tenant isolation boundary — a federated identity
  credential that trusts only `cloudable_issuer_url` and leaves the subject unset or
  wildcarded would accept a token minted for **any** Cloudable customer, since
  Cloudable's issuer is shared across all of them. Always set this to the exact
  subject Cloudable gave you; never leave it blank. See the extended warning on this
  variable in `variables.tf`.
- `federation_audience` defaults to `api://AzureADTokenExchange`, the fixed audience
  Entra ID expects for OIDC workload identity federation. Leave it unless Cloudable
  tells you otherwise.
- `resource_group_name` defaults to `rg-cloudable-managed`. Whatever you call it, the
  custom role's `assignable_scopes` is confined to this one resource group — never
  grant Cloudable subscription-scoped access (`docs/spec.md` §10).
