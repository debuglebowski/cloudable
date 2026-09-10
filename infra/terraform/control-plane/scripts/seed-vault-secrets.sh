#!/usr/bin/env bash
# Generates and writes the Key Vault secrets the control-plane module expects.
#
# Key Vault has no generate-secret API — its data plane offers Set/Get/Update/
# Delete and nothing else, and only *keys* and certificates are generated
# in-vault. So the values have to be produced somewhere, and this is that
# somewhere: one reviewed, versioned file rather than a paragraph in a README
# that drifts from what the module actually expects.
#
# Values are generated locally and piped straight into `az`. They are never
# echoed, never written to a file, and never enter Terraform state — which is
# why this is a script a human runs rather than an `azurerm_key_vault_secret`
# resource (whose `value` is a state attribute).
#
# It is also deliberately NOT an azurerm_resource_deployment_script_azure_cli.
# Azure deletes that resource once `retentionInterval` expires (26 hours max),
# so Terraform sees a 404 on the next refresh and re-creates it — meaning the
# script re-executes on every apply, forever, with only a shell `if` between
# an image bump and rotating every secret here. It would also need a
# CI-controlled identity holding Key Vault Secrets Officer, which the calling
# deploy config explicitly refuses to grant.
#
# NEVER add `set -x`. NEVER add an `echo "$value"`. Deployment logs and shell
# traces outlive the process; these values should not.
#
# Idempotent by default: an existing secret is left alone, because rotating
# these is not a no-op. better-auth-secret invalidates every user session;
# join-token-secret and agent-session-secret force every agent to re-attest.
# Use --rotate <name> to replace one deliberately.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: seed-vault-secrets.sh --vault <name> --spec <file> [--rotate <name>]... [--dry-run]

  --vault    Key Vault name (not the full URI).
  --spec     JSON spec from the module. Produce it in the directory that calls
             the module (e.g. cloudable-deploy):

               tofu output -json key_vault_secret_spec > spec.json

             That output is not sensitive: it says how the values are made,
             never what they are.
  --rotate   Replace this secret even though it already exists. Repeatable.
  --dry-run  Report what would happen; write nothing.

Requires: az (logged in, with Key Vault Secrets Officer on the vault), jq,
openssl.
EOF
  exit 2
}

VAULT="" SPEC="" DRY_RUN=0
ROTATE=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) VAULT="${2:-}"; shift 2 ;;
    --spec) SPEC="${2:-}"; shift 2 ;;
    --rotate) ROTATE+=("${2:-}"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[[ -n "$VAULT" && -n "$SPEC" ]] || usage
[[ -r "$SPEC" ]] || { echo "cannot read spec file: $SPEC" >&2; exit 1; }
for tool in az jq openssl; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not installed" >&2; exit 1; }
done

# base64url, unpadded (RFC 4648 §5). Raw bytes through `base64` rather than
# `openssl rand -base64`, so line wrapping at 64/76 columns can never end up
# inside the value on any platform — `tr -d` strips it either way.
gen() {
  LC_ALL=C openssl rand "$1" | base64 | tr '+/' '-_' | tr -d '=\n'
}

wants_rotation() {
  local name="$1" candidate
  for candidate in ${ROTATE[@]+"${ROTATE[@]}"}; do
    [[ "$candidate" == "$name" ]] && return 0
  done
  return 1
}

rc=0
while IFS=$'\t' read -r name bytes chars; do
  action="create"

  # Soft delete is on (90 days by default on this vault) and purge protection
  # is off. A soft-deleted secret 404s on `show` but REJECTS `set`, so without
  # this check the script would look like it was creating a missing secret and
  # then fail opaquely partway through.
  if az keyvault secret show-deleted --vault-name "$VAULT" --name "$name" >/dev/null 2>&1; then
    echo "ERROR   $name is soft-deleted. Recover it:" >&2
    echo "          az keyvault secret recover --vault-name $VAULT --name $name" >&2
    echo "        or purge it, then re-run." >&2
    rc=1
    continue
  fi

  if az keyvault secret show --vault-name "$VAULT" --name "$name" --query id -o tsv >/dev/null 2>&1; then
    if wants_rotation "$name"; then
      action="rotate"
      echo "WARNING rotating $name invalidates everything signed with it." >&2
    else
      echo "skip    $name (already set)"
      continue
    fi
  fi

  if ((DRY_RUN)); then
    echo "would ${action}  $name (${bytes} bytes -> ${chars} chars base64url)"
    continue
  fi

  value="$(gen "$bytes")"
  # Enforce the constraint rather than documenting it. If someone changes the
  # encoding in gen() without changing the spec, this catches it before a
  # too-long value reaches a consumer that would silently truncate it.
  if [[ ${#value} -ne $chars ]]; then
    echo "ERROR   refusing to write $name: generated ${#value} chars, spec says ${chars}" >&2
    unset value
    rc=1
    continue
  fi

  # --value puts the secret in this process's argv, briefly visible to other
  # users of this machine. `az keyvault secret set` has no stdin form. That is
  # acceptable on an operator's own laptop, and is one more reason this does
  # not run inside a shared container.
  az keyvault secret set --vault-name "$VAULT" --name "$name" \
    --value "$value" --output none
  unset value
  echo "${action}  $name (${chars} chars)"
done < <(jq -r 'to_entries[] | [.key, .value.bytes, .value.chars] | @tsv' "$SPEC")

exit "$rc"
