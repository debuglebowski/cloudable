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
# tsconfig.base.json: every app's tsconfig.json extends it, but only
# console's build (`vite build`, via esbuild) actually resolves that chain —
# control-plane/agent/tunnel-daemon's own `build` scripts don't invoke `tsc`
# at all here, so this was never needed until console's build was added.
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
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
# downloads) — and apps/console, built below into the static SPA this same
# image serves at every path `http/routes/console.ts`'s catch-all handles
# (everything outside `/api/*` and `/_internal/*`). apps/cli source is never
# copied in — its package.json above exists only so `bun install` can
# resolve the whole workspace graph.
COPY packages/contracts packages/contracts
COPY packages/events packages/events
COPY packages/schema packages/schema
COPY packages/session-token packages/session-token
COPY apps/control-plane apps/control-plane
COPY apps/agent apps/agent
COPY apps/tunnel-daemon apps/tunnel-daemon
COPY apps/console apps/console

# VITE_API_URL="" bakes an empty base URL into console's build, so its
# `fetch` calls resolve as same-origin relative paths (`/api/v1/...`) —
# correct here because this image serves both the API and the console from
# the same origin (see console.ts). Not the right default for `apps/console`
# run standalone (its own `vite dev` still defaults to
# `http://localhost:4780`, a real cross-origin API in local dev).
ENV VITE_API_URL=""

RUN bun run --cwd packages/contracts build \
 && bun run --cwd packages/events build \
 && bun run --cwd packages/schema build \
 && bun run --cwd packages/session-token build \
 && bun run --cwd apps/control-plane build \
 && bun run --cwd apps/agent build \
 && bun run --cwd apps/agent build:arm64 \
 && bun run --cwd apps/tunnel-daemon build \
 && bun run --cwd apps/tunnel-daemon build:arm64 \
 && bun run --cwd apps/console build

# Re-resolve node_modules for production only, so devDependencies
# (typescript, drizzle-kit, @testcontainers/postgresql, ...) never end up
# in the runtime image.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

# ---- Scanner --------------------------------------------------------------
# The vulnerability scanner (Trivy) that machines download from this control plane after an
# admin turns scanning on. It rides in this image, next to the agent, so machines never reach
# out to GitHub for it and an org controls which version they run.
#
# Pinned by version AND by the SHA-256 of each release tarball, and `ADD --checksum` fails the
# build if a download differs. The hashes come from the release's own checksums file
# (trivy_<version>_checksums.txt), which is signed with Sigstore. To bump: change TRIVY_VERSION,
# fetch that checksums file and its .sigstore.json bundle from the release page, verify the bundle
# with `cosign verify-blob` (identity regexp ^https://github.com/aquasecurity/trivy/, issuer
# https://token.actions.githubusercontent.com), and only then copy the two hashes below. Do not
# bump by editing the hashes alone, and do not let the scheduled rebuild change them.
# .github/workflows/trivy-pin-check.yml runs the same check in CI whenever these lines change.
#
# The manifest written at the end is the only thing the control plane reads about the scanner
# (apps/control-plane/src/domain/vulnerability-scan/scanner-release.ts). The SHA-256 in it is of the
# extracted executable, which is what an agent checks after it downloads one.
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-slim AS scanner
ARG TRIVY_VERSION=0.75.0
ARG TRIVY_SHA256_X64=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f
ARG TRIVY_SHA256_ARM64=a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3
ADD --checksum=sha256:${TRIVY_SHA256_X64} \
  https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz \
  /tmp/trivy-x64.tar.gz
ADD --checksum=sha256:${TRIVY_SHA256_ARM64} \
  https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-ARM64.tar.gz \
  /tmp/trivy-arm64.tar.gz
RUN set -eu \
 && mkdir -p /out /licenses /tmp/x64 /tmp/arm64 \
 && tar -xzf /tmp/trivy-x64.tar.gz -C /tmp/x64 trivy LICENSE \
 && tar -xzf /tmp/trivy-arm64.tar.gz -C /tmp/arm64 trivy \
 && install -m 0755 /tmp/x64/trivy /out/trivy-linux-x64 \
 && install -m 0755 /tmp/arm64/trivy /out/trivy-linux-arm64 \
 && cp /tmp/x64/LICENSE /licenses/trivy-LICENSE \
 && X64="$(sha256sum /out/trivy-linux-x64 | cut -d' ' -f1)" \
 && ARM64="$(sha256sum /out/trivy-linux-arm64 | cut -d' ' -f1)" \
 && printf '{"scanner":"trivy","version":"%s","artifacts":{"linux-x64":{"file":"trivy-linux-x64","sha256":"%s"},"linux-arm64":{"file":"trivy-linux-arm64","sha256":"%s"}}}\n' \
      "${TRIVY_VERSION}" "${X64}" "${ARM64}" > /out/scanner-manifest.json

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

# The vulnerability scanner for each CPU type and the manifest describing it, served by the same
# route (a fixed allowlist in http/routes/binaries.ts). Machines fetch it only after an admin turns
# scanning on. Trivy is Apache-2.0, so its licence text travels with it.
COPY --from=scanner --chown=bun:bun /out/ /app/binaries/
COPY --from=scanner --chown=bun:bun /licenses/ /app/licenses/

# The console's static build — `http/routes/console.ts` serves it directly
# from here (CONSOLE_DIST_DIR), no separate web server/container.
COPY --from=builder --chown=bun:bun /app/apps/console/dist /app/console-dist
ENV CONSOLE_DIST_DIR=/app/console-dist

USER bun
EXPOSE 3000

WORKDIR /app/apps/control-plane
CMD ["bun", "run", "src/server.ts"]
