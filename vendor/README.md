# Vendored packages

## `normain-idp-role-contract-0.1.0.tgz`

The shared IdP role contract (`@normain/idp-role-contract` 0.1.0), used by roles from the
identity provider (`apps/control-plane/src/idp-roles/`). The same release is pinned by Kahuna and
SlayZone, so all three parse config, map roles, decide freshness and shape audit events the same
way.

- Source: `idp-role-contract` repository, `release/normain-idp-role-contract-0.1.0.tgz`.
- SHA-256: `f54ba7da94b0330ac83f13349ac8330bed82ef7489c4576c80567e7bf0ae9fe0`
- Not published to a registry. When it is, replace the `file:` dependency with the registry
  version of the same bytes; no code changes.

Check: `shasum -a 256 vendor/normain-idp-role-contract-0.1.0.tgz`. Never edit the tarball; a new
contract release is a new file and a new pin.
