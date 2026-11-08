#!/bin/bash
# One-time bootstrap for agents predating the updater. Run as root, e.g. Azure Run Command.
# Usage: bootstrap-agent-updater.sh https://control-plane.example RELEASE_ID [/opt/cloudable/agent]
set -euo pipefail
BASE_URL=${1:?control-plane URL required}
RELEASE_ID=${2:?pin the releaseId from the deployed agent-manifest.json}
BINARY=${3:-/opt/cloudable/agent}
case "$BASE_URL" in https://*) ;; *) echo 'HTTPS control-plane URL required' >&2; exit 1;; esac
case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) exit 1;; esac
WORK=$(mktemp -d "$(dirname "$BINARY")/.agent-bootstrap.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
curl --fail --silent --show-error --max-time 60 "$BASE_URL/_internal/binaries/agent-manifest.json" -o "$WORK/manifest.json"
SHA=$(python3 - "$WORK/manifest.json" "$ARCH" "$RELEASE_ID" <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1]))
assert m['releaseId'] == sys.argv[3], 'deployed release changed; inspect manifest again'
a = m['artifacts']['linux-' + sys.argv[2]]
assert a['file'] == 'cloudable-agent-linux-' + sys.argv[2]
assert re.fullmatch('[a-f0-9]{64}', a['sha256'])
print(a['sha256'])
PY
)
curl --fail --silent --show-error --max-time 600 "$BASE_URL/_internal/binaries/cloudable-agent-linux-$ARCH" -o "$WORK/agent"
printf '%s  %s\n' "$SHA" "$WORK/agent" | sha256sum --check --status
chmod 755 "$WORK/agent"
# Keep the pre-updater binary independently of the automatic updater's own backup.
cp -p "$BINARY" "$WORK/previous"
sync "$WORK/agent" "$WORK/previous"
# Never overwrite the original bootstrap backup on a repeated invocation.
if [ ! -e "$BINARY.pre-updater" ]; then mv "$WORK/previous" "$BINARY.pre-updater"; fi
systemctl stop cloudable-agent
mv "$WORK/agent" "$BINARY"
sync "$BINARY"
if ! systemctl start cloudable-agent; then
  cp -p "$BINARY.pre-updater" "$WORK/restore"
  mv "$WORK/restore" "$BINARY"
  systemctl start cloudable-agent
  exit 1
fi
echo 'Bootstrap started. Verify lastVerifiedAt advances and installedVersion matches deployed manifest.'
echo "Pre-updater backup retained: $BINARY.pre-updater"
