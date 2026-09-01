# A "machine" for the Local Docker provisioning backend
# (`ProvisioningService.docker.ts`) — dev/demo only, never part of the real
# product surface. Runs the real compiled agent binary so the whole
# attest→poll→report→reconcile→tunnel loop is exercised against a real box.
#
# Built with `docker build --build-arg BASE_IMAGE=... --build-arg
# AGENT_BINARY=... -f docker/local-machine/Dockerfile .` from `apps/agent`
# (see `ProvisioningService.docker.ts`'s `ensureImageBuilt`) — never run by
# hand.
ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}

# `ca-certificates` so the agent's outbound HTTPS/WSS calls to a real,
# non-localhost control-plane verify correctly; local dev talks plain HTTP
# to host.docker.internal, but this keeps the image honest for that case too.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG AGENT_BINARY=dist/cloudable-agent-linux-x64
COPY ${AGENT_BINARY} /usr/local/bin/cloudable-agent
COPY docker/local-machine/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/cloudable-agent /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
