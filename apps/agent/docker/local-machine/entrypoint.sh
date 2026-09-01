#!/bin/sh
# Best-effort package install, then run the real agent. `CLOUDABLE_PACKAGES`
# is a space-separated list of declared package names (the manifest's
# `packageName`, version pins are not applied here — a declared name isn't
# guaranteed to be a real apt package at all). A failed install is logged
# and skipped rather than aborting the machine — this is a local dev
# convenience, not a provisioning guarantee.
set -u

if [ -n "${CLOUDABLE_PACKAGES:-}" ]; then
  apt-get update || true
  for name in $CLOUDABLE_PACKAGES; do
    if ! apt-get install -y --no-install-recommends "$name"; then
      echo "entrypoint: failed to install declared package '$name' — continuing" >&2
    fi
  done
fi

exec /usr/local/bin/cloudable-agent
