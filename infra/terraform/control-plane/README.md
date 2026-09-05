# Cloudable control plane — self-hosted deploy (Terraform)

**This is the only deployment mode Cloudable ships.** Cloudable is open-source and
self-hosted only — there is no Cloudable-hosted, multi-tenant BYOC mode
(`docs/cloud-auth.md`).

Self-hosted is the simplest deployment mode (`docs/spec.md` §2): one trust boundary,
one Azure tenant, a system-assigned managed identity, no federation. This module
provisions:

- One Azure Container App running the control-plane image (a single stateless
  container — see `docs/spec.md` §25: no Helm chart in v1, this or a Compose
  equivalent is the whole of it)
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

## Custom domain (do it yourself)

This module deliberately does **not** take a `custom_domain` variable — a real
self-hoster's DNS could be Cloudflare, Route53, Azure DNS, GoDaddy, or none at all, and
this repo is meant to stay a minimal, forkable starting point, not grow a variable and a
provider dependency for every DNS vendor that exists. If you want a real hostname
instead of the auto-generated Container Apps FQDN, add this to **your own copy** of
`main.tf` (validated for real against a live Azure tenant):

```hcl
# Requires bumping the azurerm provider to "~> 4.69" in versions.tf —
# azurerm_container_app_environment_managed_certificate (the free,
# auto-renewed TLS cert for a custom domain) doesn't exist before that.

resource "azurerm_container_app_custom_domain" "this" {
  name             = "cloudable.example.com" # your real hostname
  container_app_id = azurerm_container_app.this.id

  # certificate_binding_type is set asynchronously by Azure once the managed
  # certificate below finishes issuing — without ignoring it, every
  # subsequent plan sees drift.
  lifecycle {
    ignore_changes = [certificate_binding_type]
  }
}

resource "azurerm_container_app_environment_managed_certificate" "this" {
  name                          = "${var.name_prefix}-cp-cert"
  container_app_environment_id = azurerm_container_app_environment.this.id
  subject_name                  = "cloudable.example.com" # same hostname as above
  domain_control_validation     = "CNAME"

  depends_on = [azurerm_container_app_custom_domain.this]
}
```

Also point `local.public_url` (used for `BETTER_AUTH_URL`/`CONTROL_PLANE_BASE_URL`) at
your hostname instead of `local.control_plane_fqdn`.

Azure requires proof of domain ownership before it'll bind the hostname: a `TXT` record
at `asuid.<your domain>` containing `azurerm_container_app.this.custom_domain_verification_id`
(visible in `terraform plan`'s output once you add the resource above), plus a `CNAME`
pointing your domain at `local.control_plane_fqdn`. Create both however you manage DNS —
by hand, or with your DNS provider's own Terraform resource (e.g. Cloudflare's
`cloudflare_dns_record`) in your own fork.

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
