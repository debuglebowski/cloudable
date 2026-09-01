# syntax=docker/dockerfile:1.7
#
# apps/agent/Dockerfile
#
# NOT the agent's real distribution format — that's a compiled standalone
# binary (apps/agent/package.json's `build`/`build:arm64`, published via
# .github/workflows/release-agent-cli.yml) installed directly on a
# customer's VM under systemd (docs/agents.md), never run in a container
# there.
#
# This Dockerfile exists solely for test/agent-connectivity/: it runs the
# agent from source under Bun, the same way apps/control-plane/Dockerfile
# runs the control plane from source, so the two can come up as real,
# separate containers on a real Docker network and prove the wire protocol
# (attest -> poll -> report, and the tunnel-signal long poll) actually
# works over a network — not just within one process/host, which is how
# every other test of this agent in this repo runs it.

ARG BUN_VERSION=1.3.6

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

# Every workspace package.json present so Bun's workspace resolution matches
# bun.lock, mirroring apps/control-plane/Dockerfile's builder stage — but no
# multi-stage prod/dev split here: this image is a throwaway test fixture,
# never published, so a couple of extra devDependencies in it cost nothing.
COPY package.json bun.lock bunfig.toml ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN bun install --frozen-lockfile --ignore-scripts

# The agent's only real workspace dependency (@cloudable/contracts) is
# type-only (see wire-types.ts) and erased at runtime, but its source is
# copied anyway so `bun install`'s resolution and any future non-type
# import both just work without a second thought.
COPY packages/contracts packages/contracts
COPY apps/agent apps/agent

# oven/bun's own image ships a non-root `bun` user (uid/gid 1000) — same
# reasoning as the control plane's Dockerfile: no reason a bug in this
# process should hand an attacker root in the container, even in a test
# fixture.
RUN chown -R bun:bun /app
USER bun

WORKDIR /app/apps/agent
CMD ["bun", "run", "src/index.ts"]
