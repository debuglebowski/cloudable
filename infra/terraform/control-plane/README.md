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
- A managed identity on the container app (no credential is ever stored — invariant 1).
  System-assigned by default; a user-assigned one when `enable_key_vault` is set, so it
  exists before the app and survives the app being recreated — see the Key Vault
  section below.

Terraform only — no Bicep, no one-click alternative. This is open source and self-hosted
only; there's no paying-customer onboarding-friction problem to justify keeping a second IaC
format in sync.

## Prerequisites

- An Azure subscription, and `az login` already run (or another way to authenticate
  the `azurerm` provider — see the [azurerm provider auth docs][azurerm-auth])
- Terraform >= 1.5, or [OpenTofu](https://opentofu.org/) (this HCL works with either)
- An existing Key Vault, if you want the recommended setup. See
  "Key Vault-backed secrets" below for what to create in it and why. Without
  `enable_key_vault` you must instead supply `better_auth_secret` yourself, and the
  three signing secrets stay on their published `dev-only-change-me` default — read
  that section before choosing this.
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
terraform plan
terraform apply
```

With `enable_key_vault` and `enable_postgres_entra_auth` both set (the recommended
setup), no secret is passed on the command line at all. Every secret value lives in
Key Vault and the database uses managed-identity tokens, so there is nothing sensitive
to supply here and nothing sensitive in state. Set the vault's secrets first — see
"Key Vault-backed secrets" below.

Without those flags you must supply `better_auth_secret` and `postgres_admin_password`
yourself, via a `*.tfvars` file (this directory's `.gitignore` excludes `*.tfvars`
except the committed `dummy.tfvars` used for validation), `-var`, or `TF_VAR_*` env
vars. Both then sit in Terraform state in plain text. Never commit real values.

After `apply`, the deployed URL is the `control_plane_url` output.

To tear everything down: `terraform destroy`, with the same variables if you supplied any.

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

## Private networking (opt-in)

Set `enable_private_networking = true` to put Postgres behind VNet integration
(delegated subnet + private DNS zone, `public_network_access_enabled = false`) and
give the Container Apps Environment its own subnet in the same VNet, so the control
plane reaches Postgres over private IPs instead of Azure's shared "allow Azure
services" range. Public ingress to the control plane itself is unaffected — this only
changes how the app reaches its database, not how the internet reaches the app.

**On a brand-new deployment**: safe to set from the first `terraform apply`.

**On an already-deployed instance**: `delegated_subnet_id`
(`azurerm_postgresql_flexible_server`) and `infrastructure_subnet_id`
(`azurerm_container_app_environment`) are both `ForceNew` — flipping this flag on a
live deployment destroys and recreates the Postgres server (including its data) and
the Container App itself (including its managed identity — anything you granted that
identity's `principal_id` access to outside this module, e.g. a Key Vault, needs
re-granting to the new one afterward). There is no in-place path. Take an independent
`pg_dump` first, apply with the flag on, then `pg_restore` into the new (empty,
private-only) server from something inside the new VNet — the server has no public
endpoint any more, so the restore itself can't run from your laptop or CI. Budget a
real maintenance window (tens of minutes, not a rolling update), not a quick flip.

## Key Vault-backed secrets (opt-in)

Set `enable_key_vault = true` (with `key_vault_id` + `key_vault_uri`) and the Container App stops
carrying secret *values* entirely: it references Key Vault secrets by URI and resolves
them at container start using a user-assigned managed identity this module creates and
grants `Key Vault Secrets User` on that vault. Nothing sensitive lands in Terraform
state, and the application is unchanged — it still just reads environment variables.

The vault itself is deliberately not created here (soft-delete/purge protection,
network rules and naming are org-wide decisions, and a vault should outlive this
module). Neither are the secrets: writing them with `azurerm_key_vault_secret` would
put the values straight back into state, defeating the point.

Create the four the module expects, out-of-band, once, with the script in this directory:

```bash
# From the directory that CALLS this module (e.g. your own deploy config):
tofu output -json key_vault_secret_spec > /tmp/spec.json

scripts/seed-vault-secrets.sh --vault <your-vault> --spec /tmp/spec.json
```

The names and lengths are not written down here twice. They come from
`local.key_vault_secret_specs` in `main.tf` and reach the script through the
`key_vault_secret_spec` output, so adding a fifth secret is a one-line change that both
the Container App wiring and the seeding script pick up. The output describes *how* the
values are produced and never what they are, so it is not sensitive.

The script is idempotent: an existing secret is left alone, because rotating these is
not a no-op (see the warning at the end of this section). Pass `--rotate <name>` to
replace one deliberately, or `--dry-run` to see what it would do. It refuses to run
against a soft-deleted secret, which otherwise fails opaquely — Key Vault reports such a
secret as missing but rejects any attempt to set it.

**Why a script and not Terraform.** `azurerm_key_vault_secret` would put every value
straight into state. `azurerm_resource_deployment_script_azure_cli` looks like the answer
and is worse: Azure deletes that resource once `retention_interval` expires (26 hours
maximum), so the next plan sees a 404 and recreates it — the script re-runs on *every*
apply, with only a shell `if` standing between an image bump and rotating all four
secrets. It also requires a CI-controlled identity holding `Key Vault Secrets Officer`,
which is exactly the blast radius the vault was introduced to remove.

If a consumer ever caps a secret's length, set that secret's `bytes` in
`local.key_vault_secret_specs` — base64url of B bytes is exactly `ceil(B*8/6)`
characters, so 18 bytes is exactly 24 characters at 144 bits. The script verifies the
generated length against the spec before writing, so the constraint is enforced rather
than documented.

`join-token-secret`, `agent-session-secret` and `cli-auth-code-secret` have **no
plain-value fallback** on purpose. Without Key Vault the app falls back to the literal
`dev-only-change-me` compiled into it — a published default in a public repo — so
agent join tokens, agent session tokens and CLI sign-in codes would be signed with a
key anyone can read. There is intentionally no way to set them to a real value without
a vault, so a deployment can't quietly keep running on the default.

Rotating any of them is `scripts/seed-vault-secrets.sh --rotate <name>` plus a revision
restart — the references are versionless, so no Terraform change. Note that rotating
`join-token-secret` or `agent-session-secret` invalidates every outstanding token for
every org at once; agents have to re-attest.

### The plan-time check

A `check` block reports at plan time if the vault is missing any of the four, so you
find out before a revision fails to provision rather than after. It uses the
metadata-only `azurerm_key_vault_secrets` data source — that one exposes secret *names*
and has no `value` attribute at all, so nothing it reads can reach state.

Two things worth knowing about it:

- It only ever warns, never blocks. That is deliberate: an unreadable vault (RBAC still
  propagating, throttling, network rules added later) must not stop an unrelated image
  bump from deploying.
- With `enable_key_vault` unset you will see one warning per plan about a failed read.
  Nested data blocks inside a `check` cannot take `count`, and the alternative — a
  top-level counted data source — turns any read failure into a hard error that could
  wedge a pipeline. A spurious warning is the better trade.

For the check to say anything useful, the identity running Terraform needs
`Key Vault Reader` on the vault — metadata only, explicitly **not** able to read secret
values. The module creates that assignment when `deploying_identity_principal_id` is
set. Without it the check simply warns and you carry on.

## Postgres Entra authentication (opt-in)

`enable_postgres_entra_auth = true` (requires `enable_key_vault`, since it
reuses the same identity) turns on Entra auth for the database and points the control
plane at it: `DATABASE_URL` loses its password entirely and the app fetches a
short-lived managed-identity token per connection instead.

Password auth is turned **off** at the same time. No admin password exists on the
server, and `postgres_admin_password` is neither needed nor stored in state. That is
the point: it was the last secret value Terraform still held.

The cost is that there is no instant rollback. Setting the app's `DATABASE_AUTH_MODE`
back to `password` on its own will not work, because the server has no password to
authenticate against. Recovering from broken token auth means setting
`enable_postgres_entra_auth = false`, supplying a `postgres_admin_password`, and
applying again — a few minutes, not a flag flip.

Before you rely on this, confirm you can actually reach the database as the Entra
admin. A token is the only way in.

One step Terraform cannot do for you, because it is SQL against the server rather than
an ARM operation: an Entra admin (set one or more with `postgres_entra_administrators`) must
create the database role for the app's identity. Until it exists the app authenticates and
is then rejected — `password authentication failed for user "<identity name>"` — and
crashes on boot.

```sql
-- connect to the `postgres` database, NOT your application database
SELECT pgaadauth_create_principal('<app_identity_name output>', false, false);
GRANT "<postgres_admin_username>" TO "<app_identity_name output>";
```

Two things about this bite reliably:

**Connect to `postgres`, not your application database.** The `pgaadauth` extension is only
installed there; against the app database you get `function pgaadauth_create_principal(unknown,
boolean, boolean) does not exist` and nothing more helpful. Roles are cluster-wide, so
creating it from `postgres` is correct anyway.

**Grant membership in the admin role, not just `CONNECT`.** Existing tables are owned by
`postgres_admin_username`, which can no longer log in at all once this flag disables password
auth. The app runs migrations on boot and has to alter those tables, so `GRANT CONNECT` alone
leaves it authenticated with no ability to work. Membership inherits the ownership rights
without making the app a superuser — verify with `SELECT rolname, rolsuper FROM pg_roles WHERE
rolname = '<identity name>'`, where `rolsuper` must be false.

**With `enable_private_networking`, none of this can run from your machine.** The server has
no public endpoint and no firewall rule can add one; you need a shell inside the VNet. If the
Container Apps environment is VNet-integrated, a one-off Container Apps job running a
`postgres` image is the lightest way in — delete it afterwards, since it has to carry a
database access token.

## Notes

- Postgres always ships diagnostic logs + metrics to the module's Log Analytics
  workspace (no toggle — cheap, and reuses a workspace this module creates anyway).
  Health alerts (CPU/memory/disk-IOPS/storage, all permissive: >90% averaged over a
  full hour) are opt-in — set `alert_action_group_id` to an existing Azure Monitor
  Action Group's resource ID to wire them up. This module doesn't create the action
  group itself; that's org-wide alerting infrastructure out of scope for a
  single-app deploy template.
- `enable_flow_logs` (opt-in, meaningful with either `enable_self_managed_machines` or
  `enable_private_networking`, or both) turns on VNet Flow Logs, with a dedicated
  storage account (itself given a permissive availability alert when
  `alert_action_group_id` is also set — found live: a compliance scan flags storage
  accounts that lack one, this account included) and 90-day retention. Requires a
  regional Network Watcher to already exist (Azure enables one automatically per
  region unless explicitly disabled) — the flow log resources are created in *its*
  resource group, not this module's own, since that's where Azure requires them to
  live. The deploying identity needs write access there too, which this module does
  not grant.
- `control_plane_image_tag` defaults to `main`, the tag `rebuild-base-image.yml` moves
  on every push to main. Pinning by image digest instead (see the comment on that
  variable) is on you once you have a release process; swap `control_plane_image` for
  `<repo>@sha256:<digest>` when you do.
- Postgres is reachable from the container app via Azure's "allow Azure services"
  firewall rule (`0.0.0.0`–`0.0.0.0`), not a VNet/private-endpoint setup, by default.
  Per Microsoft's own docs that rule admits traffic from **any** Azure customer's
  resources, not just this deployment's container app — a deliberate simplification
  for a one-shot self-host template. Set `enable_private_networking = true` for
  VNet-integrated Postgres instead (see below); `public_network_access_enabled`/the
  firewall rule turn off automatically when you do.
- `min_replicas = 1` keeps the control plane always warm. Set it to `0` if you'd
  rather it scale to zero when idle (cold starts will apply).
- This module creates its own resource group (`resource_group_name`) rather than
  adopting an existing one.
- No self-service signup exists on `/login` — set `default_admin_email`/
  `default_admin_password` to auto-create a first admin account at startup (only takes
  effect once, the first time no account exists for that email). Without these, bootstrapping
  a first login takes manual SQL against the database plus a direct call to BetterAuth's
  `/api/auth/sign-up/email` endpoint.
- Deploying via CI/CD with a narrowly-scoped identity (rather than a subscription
  Owner/Contributor running `terraform apply` by hand)? Set
  `deploying_identity_principal_id` to that identity's object ID — otherwise, once
  `enable_self_managed_machines` creates the subscription-scoped `catalog_reader` role
  assignment, that identity can compute a plan but then 403s trying to read the
  resource back on every run. Like `catalog_reader` itself, the first `apply` that
  creates this needs an identity that already has
  `Microsoft.Authorization/roleAssignments/write` at subscription scope — the
  narrowly-scoped identity can't grant itself the read access it's missing.
