# syntax=docker/dockerfile:1.7
#
# apps/control-plane/Dockerfile
#
# Multi-stage build for the control plane API (docs/spec.md §25 "Packaging
# and distribution": one container image, published to GHCR).
#
# The base image tag below is pinned to an exact digest-free-but-specific
# version (never `:latest`) and rebuilt on a weekly schedule regardless of
# code changes — see .github/workflows/rebuild-base-image.yml and
# docs/spec.md §26 "Minimum internal compliance posture". Bump the tag here
# deliberately; don't let the scheduled rebuild silently drift it.
#
# Keep EXPOSE 3000 and the CMD entrypoint stable: infra/terraform/control-plane
# references this image.

# Single source of truth for the pinned base image tag — both stages
# below build FROM the same version. Redeclared after each FROM because
# ARG scope doesn't cross build stages; the top-level default is what
# actually pins the version (bump it here, deliberately, per the note
# above — not by overriding --build-arg at build time).
ARG BUN_VERSION=1.3.6

# ---- Builder ----------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /app

# Install with every workspace's package.json present (Bun's workspace
# resolution needs the full set to match bun.lock) but no source yet, so
# `bun install` is cached independently of application code changes.
COPY package.json bun.lock bunfig.toml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/tunnel-daemon/package.json apps/tunnel-daemon/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/e2e/package.json apps/e2e/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/session-token/package.json packages/session-token/package.json

# --ignore-scripts: several devDependencies (e.g. @testcontainers/postgresql,
# via ssh2/cpu-features) carry optional native-binding install scripts with
# no prebuilt binary for every platform. They have pure-JS fallbacks and
# nothing this image actually runs depends on the native build succeeding,
# so lifecycle scripts are skipped outright rather than letting an optional
# accelerator's failed `node-gyp` step fail the whole install.
RUN bun install --frozen-lockfile --ignore-scripts

# Bring in source only for the control plane and the workspace deps it
# actually needs — plus apps/agent and apps/tunnel-daemon, compiled below
# into standalone binaries this image serves over HTTP (services/
# ProvisioningService.azure.ts's cloud-init curls them at VM boot: a fresh
# Ubuntu VM has no Bun/Node to run TS source with, only whatever binary it
# downloads). apps/cli, apps/console source is never copied in — their
# package.json above exists only so `bun install` can resolve the whole
# workspace graph.
COPY packages/contracts packages/contracts
COPY packages/events packages/events
COPY packages/schema packages/schema
COPY packages/session-token packages/session-token
COPY apps/control-plane apps/control-plane
COPY apps/agent apps/agent
COPY apps/tunnel-daemon apps/tunnel-daemon

RUN bun run --cwd packages/contracts build \
 && bun run --cwd packages/events build \
 && bun run --cwd packages/schema build \
 && bun run --cwd packages/session-token build \
 && bun run --cwd apps/control-plane build \
 && bun run --cwd apps/agent build \
 && bun run --cwd apps/agent build:arm64 \
 && bun run --cwd apps/tunnel-daemon build \
 && bun run --cwd apps/tunnel-daemon build:arm64

# Re-resolve node_modules for production only, so devDependencies
# (typescript, drizzle-kit, @testcontainers/postgresql, ...) never end up
# in the runtime image.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

# ---- Runtime ------------------------------------------------------------
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# oven/bun's own image already ships a non-root `bun` user (uid/gid 1000).
# Own the copied tree by it and drop root before CMD runs — this is a
# network-facing server built on a dependency graph (Effect/drizzle/
# postgres/better-auth) processing untrusted HTTP input; there's no
# reason a bug in any of that should hand an attacker root in the
# container.
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/packages/contracts ./packages/contracts
COPY --from=builder --chown=bun:bun /app/packages/events ./packages/events
COPY --from=builder --chown=bun:bun /app/packages/schema ./packages/schema
COPY --from=builder --chown=bun:bun /app/packages/session-token ./packages/session-token
COPY --from=builder --chown=bun:bun /app/apps/control-plane ./apps/control-plane

# The 4 standalone binaries GET /_internal/binaries/:target serves
# (http/routes/binaries.ts) — named exactly as that route expects, so it
# can join `AGENT_BINARY_DIR`/target straight through with no lookup table.
COPY --from=builder --chown=bun:bun /app/apps/agent/dist/cloudable-agent-linux-x64 /app/binaries/cloudable-agent-linux-x64
COPY --from=builder --chown=bun:bun /app/apps/agent/dist/cloudable-agent-linux-arm64 /app/binaries/cloudable-agent-linux-arm64
COPY --from=builder --chown=bun:bun /app/apps/tunnel-daemon/dist/cloudable-tunnel-daemon-linux-x64 /app/binaries/cloudable-tunnel-daemon-linux-x64
COPY --from=builder --chown=bun:bun /app/apps/tunnel-daemon/dist/cloudable-tunnel-daemon-linux-arm64 /app/binaries/cloudable-tunnel-daemon-linux-arm64

USER bun
EXPOSE 3000

WORKDIR /app/apps/control-plane
CMD ["bun", "run", "src/server.ts"]
