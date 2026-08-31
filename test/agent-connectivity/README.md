# Agent ↔ control plane connectivity test

Every other test of the control agent in this repo (`apps/agent/src/*.test.ts`,
and every manual verification run during development) runs the agent and the
control plane in the same process or on the same host, talking over
`localhost`. That proves the wire protocol's *logic* is right, but never
proves the two can actually reach each other over a real network — which is
the situation every real deployment is in.

This test does that: it builds and runs the control plane and the agent as
two **separate Docker containers**, on their own Docker network, and has the
agent talk to the control plane by its Docker service name
(`http://control-plane:4780`), never `localhost`. If Docker's own
inter-container DNS and networking didn't work, or the agent's real
attest → poll → report cycle were broken, this fails.

It also proves the same thing for a newer wire-protocol surface: the CP →
agent **tunnel-signal channel** (`docs/agents.md`'s own section on it) — a
long-polled `GET /api/v1/tunnel/signal` the agent holds open continuously,
separate from the attest/poll/report cycle. This test mints a real session
against the containerized control plane and confirms the already-running
agent container's own logs show it received the resulting signal over the
network, not just in a same-process unit test.

## Run it

```sh
./run.sh
```

Exit code `0` means both the agent protocol and the tunnel-signal channel
really worked against the containerized control plane; `1` means one of them
didn't, with both containers' logs printed for debugging. The stack
(Postgres, control plane, agent) is always torn down on exit, pass or fail.

## What it does

1. Builds and runs `packages/schema`'s migrations against a fresh, empty
   Postgres container (`migrate` — one-shot, exits).
2. Seeds one real org + machine and mints a real join token
   (`apps/control-plane/scripts/seed-agent.ts`, run as `seed` — one-shot,
   exits, prints `orgId=`/`machineId=`/`MACHINE_TOKEN=`).
3. Flips that machine to `running` directly via `psql` — `mintSession`
   (step 5 below) refuses any machine that isn't, and the seed script itself
   is shared with other manual/local uses, so this test adjusts the row
   itself rather than changing what that script seeds for everyone.
4. Builds and starts the control plane container (host port `4820` — offset
   for this unit, see `docker-compose.yml`'s own comment) and the agent
   container with `CONTROL_PLANE_URL=http://control-plane:4780` and the real
   `MACHINE_TOKEN` from step 2.
5. Polls Postgres directly (`docker compose exec postgres psql`) for the
   `agent.attested` and `machine.first_seen`/`machine.state_reported` events
   the agent's real poll/report loop should produce, up to 30s.
6. Mints a real session via `POST http://localhost:4820/api/v1/access/sessions`
   (curl'd from the host, against the port exposed in step 4) for the seeded
   org/machine, then greps the agent container's own logs (`docker compose
   logs agent`) for `tunnel-signal: session <id> waiting`, up to 20s.

The `session_terminate` half of the tunnel-signal channel
(`TunnelServer.terminateSessionsForMachine`) is deliberately **not**
exercised here — there's no production HTTP route that calls it yet (a
future unit wires "disable access" into machine/policy settings), so there's
nothing this real-network harness could trigger it through without reaching
into control-plane internals directly, which it never does. That path is
covered by unit tests instead:
`apps/control-plane/src/tunnel/server.test.ts` (the push itself) and
`apps/agent/src/tunnel/signal-listener.test.ts` (the agent's dispatch).

## Why this is separate from `apps/control-plane/test/testcontainers.ts`

That file (and `docs/access.md`/`docs/lifecycle.md`, which document why it's
unused) tried wiring the **Testcontainers library** into `bun test` for
DB-backed control-plane tests, and it hangs in this environment. This test
sidesteps that specific problem: it never uses the Testcontainers library at
all, just plain `docker compose` commands run directly from a shell script —
the same tool this repo's own local dev workflow (`docker-compose.yml` at the
repo root) already relies on successfully.

## Neither Dockerfile here is the real deployment format

`apps/control-plane/Dockerfile` is (spec §25 — one image, published to GHCR).
`apps/agent/Dockerfile` is **not** — the agent's real distribution is a
compiled standalone binary installed under systemd on a customer's VM
(`apps/agent/package.json`'s `build`/`build:arm64`). `apps/agent/Dockerfile`
exists solely so this test can run the agent as a container; it runs it from
source under Bun, same as the control plane's own image does for itself.
