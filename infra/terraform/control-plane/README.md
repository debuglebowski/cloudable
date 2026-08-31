# Cloudable control plane — self-hosted deploy (Terraform)

**This is for self-hosters only.** If you're running Cloudable BYOC or fully-managed
(Cloudable hosts the control plane for you), you don't need this — see
`infra/terraform/federated-credential/` instead, which is the artefact BYOC customers
run to federate their tenant so a Cloudable-hosted control plane can manage machines
in it.

Self-hosted is the simplest deployment mode (`docs/spec.md` §2): one trust boundary,
one Azure tenant, a system-assigned managed identity, no federation. This module
provisions:

- One Azure Container App running the control-plane image (a single stateless
  container — see `docs/spec.md` §25: no Helm chart in v1, this or a Compose
  equivalent is the whole of it)
- An Azure Database for PostgreSQL Flexible Server + database for it to use
- A system-assigned managed identity on the container app (no credential is ever
  stored — invariant 1)

The equivalent one-click template is `infra/bicep/control-plane.bicep`.

## Prerequisites

- An Azure subscription, and `az login` already run (or another way to authenticate
  the `azurerm` provider — see the [azurerm provider auth docs][azurerm-auth])
- Terraform >= 1.5, or [OpenTofu](https://opentofu.org/) (this HCL works with either)
- A published control-plane container image. Until Cloudable publishes one to GHCR,
  build and push your own from `apps/control-plane/Dockerfile` — see the Dockerfile
  note below
- A generated `BETTER_AUTH_SECRET` (e.g. `openssl rand -base64 32`)

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

## Notes

- `control_plane_image_tag` defaults to `latest`. Cloudable's own production deploys
  pin by image digest instead (see the comment on that variable, and `docs/spec.md`
  §26 on `cloudable-deploy`) — that discipline is on you once you have a release
  process; swap `control_plane_image` for `<repo>@sha256:<digest>` when you do.
- Postgres is reachable from the container app via Azure's "allow Azure services"
  firewall rule (`0.0.0.0`–`0.0.0.0`), not a VNet/private-endpoint setup. Per
  Microsoft's own docs that rule admits traffic from **any** Azure customer's
  resources, not just this deployment's container app — a deliberate simplification
  for a one-shot self-host template; harden it yourself (VNet integration / private
  endpoints) if your compliance posture requires network isolation.
- `min_replicas = 1` keeps the control plane always warm. Set it to `0` if you'd
  rather it scale to zero when idle (cold starts will apply).
- This module creates its own resource group (`resource_group_name`) rather than
  adopting an existing one — `infra/bicep/control-plane.bicep` mirrors this by
  deploying at subscription scope and creating the same resource group itself, so
  the two templates stay consistent about who owns it.
