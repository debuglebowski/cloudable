#!/usr/bin/env bash
#
# test/agent-connectivity/run.sh
#
# Proves the control agent and the control plane actually talk to each
# other over a real network: brings up Postgres, the control plane, and the
# agent as three separate Docker containers (docker-compose.yml, same
# directory), seeds one real machine + join token, lets the agent run its
# real attest -> poll -> report loop against the containerized control
# plane by its Docker service name (not localhost), then queries Postgres
# directly for the events that loop should have produced.
#
# Also exercises this unit's own new wire-protocol surface, the CP -> agent
# tunnel-signal channel (docs/agents.md): mints a real session against the
# containerized control plane's host-mapped port, then confirms the
# already-running agent container's own logs show it received the
# resulting `session_waiting` signal over the same real Docker network —
# not the terminate-signal path too (see this script's own comment further
# down for why that one is covered by unit tests instead).
#
# Tears everything down on exit regardless of outcome.
#
# Usage: ./run.sh   (from anywhere — it cd's to its own directory first)
# Exit code 0 = both the agent protocol and the tunnel-signal channel
# worked end to end over the network.
# Exit code 1 = one of them didn't; container logs are dumped before exiting.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE=(docker compose -f docker-compose.yml)
ENV_FILE=.env
PASS=0
# Host-mapped control-plane port — kept in one place since docker-compose.yml's own port
# mapping and every curl below must agree (see docker-compose.yml's comment on the N=3 offset
# this number reflects).
CONTROL_PLANE_HOST_PORT=4820

cleanup() {
  echo "==> tearing down"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1"
  echo "--- control-plane logs ---"
  "${COMPOSE[@]}" logs control-plane 2>&1 | tail -n 60
  echo "--- agent logs ---"
  "${COMPOSE[@]}" logs agent 2>&1 | tail -n 60
  exit 1
}

echo "==> building + running migrations (also brings up postgres)"
"${COMPOSE[@]}" run --rm migrate || fail "migrations did not apply"

echo "==> seeding a real org + machine, minting a real join token"
SEED_OUTPUT=$("${COMPOSE[@]}" run --rm seed) || fail "seeding failed"
echo "$SEED_OUTPUT"

ORG_ID=$(echo "$SEED_OUTPUT" | grep -oE '^orgId=.*' | cut -d= -f2)
MACHINE_ID=$(echo "$SEED_OUTPUT" | grep -oE '^machineId=.*' | cut -d= -f2)
MACHINE_TOKEN=$(echo "$SEED_OUTPUT" | grep -oE '^MACHINE_TOKEN=.*' | cut -d= -f2-)
[ -n "$ORG_ID" ] || fail "could not parse orgId from seed output"
[ -n "$MACHINE_ID" ] || fail "could not parse machineId from seed output"
[ -n "$MACHINE_TOKEN" ] || fail "could not parse MACHINE_TOKEN from seed output"

# `mintSession` (this unit's own trigger for the tunnel-signal scenario below) refuses any
# machine that isn't `running` — seed-agent.ts itself leaves a freshly-seeded machine at its
# schema default (`provisioning`) on purpose (it's shared with other manual/local uses, see its
# own header comment), so this script flips it directly rather than changing that script's
# behavior for every caller.
echo "==> flipping the seeded machine to running (mintSession requires it)"
"${COMPOSE[@]}" up -d postgres >/dev/null
"${COMPOSE[@]}" exec -T postgres psql -U cloudable -d cloudable -c \
  "update machines set state = 'running' where id = '${MACHINE_ID}'" >/dev/null \
  || fail "could not flip seeded machine to running"

# docker compose auto-loads a .env file from its project directory — this is
# how the agent service (which requires MACHINE_TOKEN, see docker-compose.yml)
# gets a value that only exists after the seed step above has run.
echo "MACHINE_TOKEN=${MACHINE_TOKEN}" > "$ENV_FILE"

echo "==> building + starting control-plane and agent (agent waits for control-plane's healthcheck)"
"${COMPOSE[@]}" up -d --build control-plane agent || fail "containers did not start"

echo "==> waiting for the agent's real attest -> poll -> report cycle to reach Postgres"
DEADLINE=$((SECONDS + 30))
AGENT_PROTOCOL_PASS=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  ATTESTED=$("${COMPOSE[@]}" exec -T postgres psql -U cloudable -d cloudable -tAc \
    "select count(*) from events where type = 'agent.attested' and machine_id = '${MACHINE_ID}'" 2>/dev/null || echo 0)
  REPORTED=$("${COMPOSE[@]}" exec -T postgres psql -U cloudable -d cloudable -tAc \
    "select count(*) from events where type in ('machine.first_seen', 'machine.state_reported') and machine_id = '${MACHINE_ID}'" 2>/dev/null || echo 0)
  if [ "${ATTESTED:-0}" -ge 1 ] && [ "${REPORTED:-0}" -ge 1 ]; then
    AGENT_PROTOCOL_PASS=1
    break
  fi
  sleep 2
done

if [ "$AGENT_PROTOCOL_PASS" -ne 1 ]; then
  fail "agent never produced agent.attested + machine.first_seen/state_reported for machine ${MACHINE_ID} within 30s — the real network round trip did not complete"
fi
echo "PASS: agent attested and reported over the real Docker network (machine ${MACHINE_ID})"

echo "==> minting a real session against the containerized control plane (tunnel-signal scenario)"
PERSON_ID=$(bun -e "console.log(crypto.randomUUID())")
MINT_BODY=$(printf '{"orgId":"%s","personId":"%s","idpIdentity":"test@example.com","targetMachineId":"%s","targetOsUser":"ubuntu","method":"terminal"}' \
  "$ORG_ID" "$PERSON_ID" "$MACHINE_ID")
MINT_RESPONSE=$(curl -sf -X POST "http://localhost:${CONTROL_PLANE_HOST_PORT}/api/v1/access/sessions" \
  -H 'content-type: application/json' -d "$MINT_BODY") || fail "mintSession call failed"
echo "$MINT_RESPONSE"

SESSION_ID=$(echo "$MINT_RESPONSE" | grep -oE '"sessionId":"[^"]+"' | cut -d'"' -f4)
[ -n "$SESSION_ID" ] || fail "could not parse sessionId from mintSession response"

echo "==> waiting for the agent's tunnel-signal listener to log receipt of session ${SESSION_ID}"
DEADLINE=$((SECONDS + 20))
SIGNAL_PASS=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if "${COMPOSE[@]}" logs agent 2>&1 | grep -qF "tunnel-signal: session ${SESSION_ID} waiting"; then
    SIGNAL_PASS=1
    break
  fi
  sleep 1
done

if [ "$SIGNAL_PASS" -ne 1 ]; then
  fail "agent never logged receipt of tunnel-signal session ${SESSION_ID} within 20s — the signal never reached it over the real Docker network"
fi
echo "PASS: agent received the session_waiting tunnel signal over the real Docker network (session ${SESSION_ID})"

# The session_terminate half of this same channel (TunnelServer.terminateSessionsForMachine,
# apps/control-plane/src/tunnel/server.ts) is intentionally NOT exercised here: there is no
# production HTTP route that calls it yet (docs/access.md — a future unit wires "disable
# access" into machine/policy settings and calls it from there), so there is nothing this
# script could trigger it through except reaching into control-plane internals directly,
# which this real-network harness deliberately never does. That path is covered instead by
# `apps/control-plane/src/tunnel/server.test.ts` (asserts the push itself happens) and
# `apps/agent/src/tunnel/signal-listener.test.ts` (asserts the agent dispatches a
# `session_terminate` message correctly) — see this unit's PR description.

PASS=1
echo "PASS: agent protocol + tunnel-signal channel both worked over the real Docker network"
