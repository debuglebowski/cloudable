# Scope

See `CLAUDE.md` for invariants, stack, and terminology. See `docs/spec.md` for the full reasoning
behind every decision referenced below.

## In v1

Everything in the build order in `docs/spec.md` except the items listed under "Not in v1" there:
control plane + reconciliation loop (fake Azure provider — no real Azure account is used in this
build), agent with join-token and managed-identity attestation, generic approval object, all six
compliance checks with finding age and control mapping, package manifest with org→machine
inheritance, cloud provider federation (OIDC issuer), SSH CA + `cloudable login`, tunnel daemon +
web terminal, secrets injection, logging tiers + evidence projection, archive lifecycle + offboarding,
elevation/break-glass, transactional upgrades, config editor/GitOps path, and the full console.

## Not in v1 (scope 2+)

Template layer, Tailscale integration, in-tenant provisioning worker. See `CLAUDE.md` "Not in v1".

## Explicitly out of this repository

`cloudable-deploy` (image digests, deploy pipeline, break-glass via Entra PIM) is a **separate,
private** repository — it is not part of this monorepo.
