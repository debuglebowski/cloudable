# Cloudable control plane — self-hosted deploy (Terraform)

**This is the only deployment mode Cloudable ships.** Cloudable is open-source and
self-hosted only — there is no Cloudable-hosted, multi-tenant BYOC mode
(`docs/cloud-auth.md`).

Self-hosted is the simplest deployment mode (`docs/spec.md` §2): one trust boundary,
one Azure tenant, a system-assigned managed identity, no federation. This module
provisions:

- One Azure Container App running the control-plane image (a single stateless
  container — see `docs/spec.md` §25: no Helm chart in v1, this or a Compose
  equivalent is the whole of it). The same container serves the console web UI
  too, at every path outside `/api/*`/`/_internal/*` (`http/routes/console.ts`)
  — one image, one Container App, no separate frontend service to deploy.
- An Azure Database for PostgreSQL Flexible Server + database for it to use
- A system-assigned managed identity on the container app (no credential is ever
  stored — invariant 1)

Terraform only — no Bicep, no one-click alternative. This is open source and self-hosted
only; there's no paying-customer onboarding-friction problem to justify keeping a second IaC
format in sync.

## Prerequisites

- An Azure subscription, and `az login` already run (or another way to authenticate
  the `azurerm` provider — see the [azurerm provider auth docs][azurerm-auth])
- Terraform >= 1.5, or [OpenTofu](https://opentofu.org/) (this HCL works with either)
- A generated `BETTER_AUTH_SECRET` (e.g. `openssl rand -base64 32`)
- Nothing else for the image: `.github/workflows/rebuild-base-image.yml` publishes it
  publicly to `ghcr.io/debuglebowski/cloudable/control-plane` (the default for
  `control_plane_image`/`control_plane_image_tag`) — no registry credential needed.
  `control_plane_image_registry_username`/`control_plane_image_registry_password` exist
  only for pointing at a private image of your own (see the Dockerfile note below).

[azurerm-auth]: https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/guides/service_principal_client_secret

### On the control-plane image

`apps/control-plane/Dockerfile` is a multi-stage `oven/bun` build (build the
workspace's TypeScript packages it depends on, then copy only the production
`node_modules` and built output into a slim, non-root runtime image). Build and push
it, e.g.:

```bash
docker build -t ghcr.io/<you>/cloudable-control-plane:latest -f apps/control-plane/Dockerfile .
docker push ghcr.io/<you>/cloudable-control-plane:latest
```

Point `control_plane_image` / `control_plane_image_tag` (see `variables.tf`) at
whatever you pushed.

## Commands

```bash
cd infra/terraform/control-plane

terraform init

# Required: postgres_admin_password, better_auth_secret (both sensitive — pass via
# a *.tfvars file (this directory's .gitignore excludes *.tfvars except the
# committed dummy.tfvars used for validation), -var, or TF_VAR_* env vars —
# never commit real values).
terraform plan \
  -var="postgres_admin_password=<a strong password>" \
  -var="better_auth_secret=$(openssl rand -base64 32)"

terraform apply \
  -var="postgres_admin_password=<a strong password>" \
  -var="better_auth_secret=$(openssl rand -base64 32)"
```

After `apply`, the deployed URL is the `control_plane_url` output.

To tear everything down: `terraform destroy` with the same variables.

## Verifying this template without an Azure account

This module was validated with `terraform validate` and `terraform plan` against
`dummy.tfvars` in this directory — **never `apply`**, since no real Azure account
exists in the build that produced it. `terraform validate` is the meaningful,
environment-independent check; whether `terraform plan` also succeeds depends on
whatever ambient Azure CLI/credential state happens to be present in the shell it's
run from (it printed a full 8-resource plan in the environment that produced this
module, purely because that shell already had `az login` state — that is not a
signal this module is safe to `apply` anywhere).

## Custom domain (do it yourself, in your own deploy config)

This module deliberately does **not** bind a custom domain or touch DNS itself — a real
self-hoster's DNS could be Cloudflare, Route53, Azure DNS, GoDaddy, or none at all, and this
module is meant to stay a minimal, generic building block, not grow a provider dependency
for every DNS vendor that exists. What it *does* provide: an optional `custom_domain`
variable (only changes what `BETTER_AUTH_URL`/`CONTROL_PLANE_BASE_URL`/the
`control_plane_url` output say — binds nothing), and three outputs
(`container_app_id`, `container_app_environment_id`, `custom_domain_verification_id`) a
calling root config needs to bind one for real.

The intended pattern: your own **real deploy repo** (see `docs/spec.md` §26's
`cloudable-deploy`, "Terraform values, not code") calls this module and adds the binding
itself, since it already has to pin real values regardless:

```hcl
# In your own deploy repo's main.tf, alongside `module "control_plane" { ... }` (this
# repo's own cloudable-deploy validated exactly this, for real, against a live tenant).
# Requires azurerm "~> 4.69" or newer in that repo's own versions.tf —
# azurerm_container_app_environment_managed_certificate (the free, auto-renewed TLS
# cert for a custom domain) doesn't exist before that. This module's own azurerm
# constraint (versions.tf) is deliberately wide enough to coexist with it.

module "control_plane" {
  source = "git::https://github.com/debuglebowski/cloudable.git//infra/terraform/control-plane?ref=<commit-sha>"
  custom_domain = "cloudable.example.com" # same hostname as below
  # ... your other real values
}

resource "azurerm_container_app_custom_domain" "this" {
  name             = "cloudable.example.com" # same hostname as above
  container_app_id = module.control_plane.container_app_id

  # certificate_binding_type doesn't get set to "SniEnabled" automatically —
  # verified for real against a live tenant: `az containerapp hostname list`
  # showed "Disabled" immediately after `apply` completed, and it stayed
  # that way. It's in ignore_changes because Terraform can't set it without
  # a circular dependency (the cert below already depends on this resource;
  # having this resource reference the cert's id back would cycle) — one
  # manual step finishes the binding, see below.
  lifecycle {
    ignore_changes = [certificate_binding_type]
  }
}

resource "azurerm_container_app_environment_managed_certificate" "this" {
  name                          = "cloudable-cp-cert"
  container_app_environment_id = module.control_plane.container_app_environment_id
  subject_name                  = "cloudable.example.com" # same hostname as above
  domain_control_validation     = "CNAME"

  depends_on = [azurerm_container_app_custom_domain.this]
}
```

Azure requires proof of domain ownership before it'll bind the hostname: a `TXT` record
at `asuid.<your domain>` containing `module.control_plane.custom_domain_verification_id`,
plus a `CNAME` pointing your domain at the auto-generated FQDN (`control_plane_url`
output, before you set `custom_domain`). Create both however you manage DNS — by hand, or
with your DNS provider's own Terraform resource (e.g. Cloudflare's `cloudflare_dns_record`)
in that same deploy repo.

Once both resources apply and DNS has propagated, bind them together — this last step doesn't
happen on its own:

```bash
az containerapp hostname bind \
  --hostname cloudable.example.com \
  --name <container_app_name output> \
  --resource-group <resource_group_name output> \
  --certificate "$(az containerapp env certificate list \
      --name <container app environment name> --resource-group <resource_group_name output> \
      --query "[0].id" -o tsv)"
```

Confirm with `curl https://cloudable.example.com/api/v1/health` — a valid certificate and
`{"status":"ok"}`, not a TLS handshake failure.

**Set `custom_domain` only after the binding above is actually live** — setting it first
points `BETTER_AUTH_URL`/`CONTROL_PLANE_BASE_URL` at a hostname nothing serves yet, breaking
auth/CORS until the binding catches up.

## Notes

- `control_plane_image_tag` defaults to `main`, the tag `rebuild-base-image.yml` moves
  on every push to main. Pinning by image digest instead (see the comment on that
  variable) is on you once you have a release process; swap `control_plane_image` for
  `<repo>@sha256:<digest>` when you do.
- Postgres is reachable from the container app via Azure's "allow Azure services"
  firewall rule (`0.0.0.0`–`0.0.0.0`), not a VNet/private-endpoint setup. Per
  Microsoft's own docs that rule admits traffic from **any** Azure customer's
  resources, not just this deployment's container app — a deliberate simplification
  for a one-shot self-host template; harden it yourself (VNet integration / private
  endpoints) if your compliance posture requires network isolation.
- `min_replicas = 1` keeps the control plane always warm. Set it to `0` if you'd
  rather it scale to zero when idle (cold starts will apply).
- This module creates its own resource group (`resource_group_name`) rather than
  adopting an existing one.
- Deploying via CI/CD with a narrowly-scoped identity (rather than a subscription
  Owner/Contributor running `terraform apply` by hand)? Set
  `deploying_identity_principal_id` to that identity's object ID — otherwise, once
  `enable_self_managed_machines` creates the subscription-scoped `catalog_reader` role
  assignment, that identity can compute a plan but then 403s trying to read the
  resource back on every run. Like `catalog_reader` itself, the first `apply` that
  creates this needs an identity that already has
  `Microsoft.Authorization/roleAssignments/write` at subscription scope — the
  narrowly-scoped identity can't grant itself the read access it's missing.
