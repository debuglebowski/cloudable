# A "machine" for the Local Docker provisioning backend
# (`ProvisioningService.docker.ts`) — dev/demo only, never part of the real
# product surface. Runs the real compiled agent binary (attest→poll→
# report→reconcile loop) AND the real compiled tunnel-daemon binary (the
# persistent connection web-terminal/SSH sessions actually attach through —
# see docs/agents.md's "two separate agents" design) so the whole access
# path is exercised against a real box instead of simulated.
#
# Built with `docker build --build-arg BASE_IMAGE=... --build-arg
# AGENT_BINARY=... --build-arg TUNNEL_DAEMON_BINARY=... -f
# docker/local-machine/Dockerfile .` from `apps/agent` (see
# `ProvisioningService.docker.ts`'s `ensureImageBuilt`) — never run by hand.
# `TUNNEL_DAEMON_BINARY` is staged into `apps/agent/dist/` by
# `ensureTunnelDaemonBinaryBuilt` before this ever runs, even though its
# real source is the sibling `apps/tunnel-daemon` package — see that
# function's own comment for why (the repo root's `.dockerignore` excludes
# `**/dist`, so the build context can't simply move to the repo root).
ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}

# `ca-certificates` so outbound HTTPS/WSS calls to a real, non-localhost
# control-plane verify correctly; local dev talks plain HTTP to
# host.docker.internal, but this keeps the image honest for that case too.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The one Unix user sessions run as. `MACHINE_OS_USER` ("cloudable") is chosen
# server-side and baked into every session token's `targetOsUser` claim
# (`tunnel/server.ts`); both `pty.ts` and `files-session.ts` then `su - ` into it
# on this box. Without the account, `su` fails and EVERY session — web terminal
# and file session alike — dies at spawn on the local Docker provider, which is
# exactly what was happening: this image predates the change that moved sessions
# off root, and nothing here had created the user since.
#
# A real home directory matters as well as the account: `su -` is a login shell
# and the file browser opens at `/home/cloudable`.
ARG MACHINE_OS_USER=cloudable
RUN useradd --create-home --shell /bin/bash ${MACHINE_OS_USER}

ARG AGENT_BINARY=dist/cloudable-agent-linux-x64
ARG TUNNEL_DAEMON_BINARY=dist/cloudable-tunnel-daemon-linux-x64
COPY ${AGENT_BINARY} /usr/local/bin/cloudable-agent
COPY ${TUNNEL_DAEMON_BINARY} /usr/local/bin/cloudable-tunnel-daemon
COPY docker/local-machine/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/cloudable-agent /usr/local/bin/cloudable-tunnel-daemon /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
