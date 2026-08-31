# Agents

Two separate daemons run on a Cloudable machine. Different trust levels,
different failure domains (spec §8). This doc covers the **control agent**
in full — it's this repo's `apps/agent` — and the **tunnel daemon** at
spec-level detail only; nothing in `apps/agent` implements it.

## Control agent

Systemd service (`apps/agent/systemd/cloudable-agent.service`), pull-only,
no inbound access ever (invariant #7). One binary, compiled per-arch via
`bun build --compile` (`apps/agent/package.json`'s `build`/`build:arm64`).

On boot it attests its identity, then loops: poll desired state, reconcile
locally, report observed state, sleep, repeat.

### Attestation

An `AttestationMethod` port (`apps/control-plane/src/services/attestation/AttestationMethod.ts`)
with two operations, both on opaque strings (spec §9):

```ts
interface AttestationMethod {
  readonly method: "join_token" | "managed_identity";
  issueCredential(claim: CredentialClaim): Effect<string, AttestationError>;
  verifyCredential(credential: string): Effect<MachineIdentity, AttestationError>;
}
```

**Join tokens** (`JoinTokenAttestation.ts`) are the first-class implementation
here — not a fallback (spec §9) — used by local development, testing, and
bare metal (bare metal is another provider implementation, not a special
case: it has no IMDS to hand it a managed-identity token, so it attests the
same way a dev machine does). A join token is a pre-shared secret an org
admin generates and gives to a machine at boot; the agent reads it from the
`MACHINE_TOKEN` env var.

A join token is a self-contained, HMAC-signed opaque string —
`jt.<base64url payload>.<base64url signature>` — verified with a server
secret (`JOIN_TOKEN_SECRET`, defaulting to a dev-only value like the rest of
this build's config). It carries `{orgId, machineId}` directly, so
verification never needs a database round trip and this unit didn't need to
add a token-storage migration to `packages/schema` (owned elsewhere).
**Tradeoff:** an individual leaked token can't be revoked — only rotating
`JOIN_TOKEN_SECRET` invalidates every outstanding token for every org at
once. Worth a real `join_tokens` table (hash + `revoked_at`) once per-token
revocation is a real requirement.

Unit 4 adds Azure managed identity — a token from IMDS, verified against
the published key set — as a **second** `AttestationMethod` implementation
alongside this one, wired in through the same `attestation` adapter slot in
`apps/control-plane/src/layers.ts`/`server.ts`. Nothing about the port
changes; it was kept free of any join-token-specific assumption
(no database access, no assumption about how the opaque string is
structured) specifically so that could be true.

`verifyCredential` failing is a specific, typed rejection
(`AttestationError`, `reason: "malformed_credential" | "invalid_signature"`),
never a generic crash. The HTTP layer (`apps/control-plane/src/http/handlers/agent-protocol.ts`)
turns that into a 401 (`AttestRejected`) and always emits
`agent.attestation_failed` — per spec §23, this is one of the two event
types the control plane emits itself rather than deriving from agent-
reported state, because the control plane is the party doing the
rejecting. A credential that verifies cryptographically but names a
machine that doesn't exist, belongs to a different org, or is archived is
rejected the same way, for the same reason: the signature only proves the
*credential* is genuine, not that acting on its claim is still valid.

Since a rejected credential might not decode at all, there's often no real
org to attribute the failure event to. `events.org_id` is `NOT NULL`
(invariant/spec §24), so a fully undecodable credential's failure event
uses a documented all-zero UUID sentinel rather than skipping the event —
see `UNATTRIBUTED_ORG_ID` in `agent-protocol.ts`. A credential with a valid
*shape* but wrong signature still gets attributed to its claimed org —
useful for audit, never trusted for authorization.

### Bearer sessions

`POST /attest` doesn't hand the agent a join token back — it mints a
separate, short-lived **bearer token** (`AgentSessionToken.ts`, 15 minutes
by default, `AGENT_SESSION_TTL_SECONDS`) that the agent caches and sends as
`Authorization: Bearer <token>` on every `/poll` and `/report` call. This is
deliberately a different mechanism from `AttestationMethod`: *which
credential proved the machine's identity* is pluggable (join token today,
managed identity later); *how long the resulting session lasts and how
it's carried* is not, and only ever needs one implementation. Same
self-contained-HMAC-string design as join tokens, for the same reason (no
database round trip, no new schema).

The agent (`apps/agent/src/attestation.ts`) re-attests automatically:
proactively when the cached token is close to expiring, and reactively if
a `/poll` or `/report` call comes back `401`.

### The four protocol operations

One `HttpApiGroup` (`agent-protocol`, `/api/v1/agent/*`, spec §23):

| Operation | Method | Notes |
|---|---|---|
| Attest | `POST /attest` | Credential → machine identity → bearer token. Rejects with 401 + `agent.attestation_failed`, never a crash. |
| Poll | `GET /poll` | Desired state. `If-None-Match` / `ETag`; `304` when unchanged. |
| Report | `POST /report` | Observed state, submitted after the agent reconciles locally. |
| Wake | `GET /wake` (websocket) | Optional fast path, CP → agent. See below. |

**Poll** returns a minimal stub shape today
(`{version, packages, settings}`) — unit 2's package manifest isn't merged
yet. The `ETag`/`304` mechanics are real and load-bearing (the handler
always returns a raw `HttpServerResponse` with the header set, bypassing
the declared success schema for the 304 case, since a 304 has no body);
there's just nothing yet that varies the desired state per machine or over
time, so the version is currently constant. Extend `DesiredStateResponse`
(`packages/contracts/src/domains/agent-protocol.ts`) additively once the
manifest lands.

**Report** persists `machines.last_verified_at` and derives events
*server-side* from the observed-state diff — the agent never submits audit
events (invariant #12/spec §23): a user with root on their own machine
could otherwise author their own audit history, and they're exactly the
person the compliance checks exist to catch. Today that derivation is
intentionally simple:

- `last_verified_at` was `NULL` → `machine.first_seen`.
- Otherwise, an **in-memory**, per-process diff of `installedPackages` /
  `openPorts` / `configState.runningAccessMethods` against the previous
  report → `machine.state_reported` if anything changed, nothing if it
  didn't (a no-op reconcile is not an event — spec §24).
  `configState` is the "config state" half of "installed packages and
  config state" (spec §8.1): narrow and cheap-to-observe today — just
  which access methods (spec §11) the agent found an actually-running
  process for, e.g. a web terminal — see `packages/contracts/src/domains/
  agent-protocol.ts`'s `ConfigState` doc comment.

That in-memory cache is a deliberate, documented stand-in, not the final
design: it resets on every control-plane restart (so one spurious
`machine.state_reported` per machine can follow a deploy — an accepted,
documented false positive) and only holds for a single process (multiple
control-plane replicas would each keep their own). Diffing against
*persisted* last-observed state needs a `packages/schema` column this unit
doesn't own. Unit 6 replaces this with its proper `deriveEvents` pattern;
this unit only had to make the two event types real enough to be useful in
the meantime.

**Wake** is real. `HttpApiEndpoint`/`HttpApiGroup` model HTTP verbs, not a
websocket upgrade, so it isn't part of `AgentProtocolGroup` — instead
`apps/control-plane/src/http/routes/agent-wake.ts` mounts a raw route
directly on the shared `HttpApiBuilder.Router` (the same `HttpRouter`
instance `HttpApiBuilder.serve()` turns into the one running `HttpApp`),
using `@effect/platform-bun`'s `HttpServerRequest.upgrade` getter to
perform the upgrade against that same `Bun.serve` instance — no second
port, no raw `Bun.serve({websocket})` alongside the Effect router.

The route bearer-authenticates the upgrade the same way as `/poll`/`/report`
(but only once, at the upgrade — this channel never carries another message
from the agent to re-verify against), then registers the socket in an
in-memory `WakeRegistry` keyed by `machineId` and blocks that route's own
fiber until the connection closes, at which point it unregisters. A second
connection for the same machine (a reconnect) replaces the first and
actively closes the one it displaces, rather than leaking it.
`WakeRegistry.wake(machineId)` sends exactly `{"type":"pull_now"}` — the
wire contract in `WakeMessage`
(`packages/contracts/src/domains/agent-protocol.ts`) — to whichever socket
is currently registered for that machine, and reports back whether one was
found; nothing in this build calls it yet (poll's own desired state is
still a stub, so there's nothing yet to notify a machine about), so the
channel is wired end-to-end but currently idle.

`apps/agent/src/wake.ts`'s `connectWake` is the agent side: it dials out
(invariant #7 — the control plane only ever sends on a connection the
agent already opened) with the cached bearer token, and reconnects with
the same full-jitter backoff as the poll/report loop on any drop.
`poll-report-loop.ts` wires its `onPullNow` callback into the sleep
between cycles, so a wake short-circuits the wait instead of the machine
sitting out its full ~30s interval — the agent still finds out *what*
changed via the next `poll`, same as before.

**In-memory, per-process, single-replica only** — like `AgentSessionToken`'s
signing secret and `agent-protocol.ts`'s `lastObserved` diff cache,
`WakeRegistry` lives in one control-plane process. A machine's wake socket
only exists on whichever replica it happened to connect to; a `wake()` call
handled by a *different* replica finds nothing registered and reports "not
delivered," even though the machine is connected — to a sibling. This is a
real gap against `infra/bicep/control-plane.bicep` and
`infra/terraform/control-plane/variables.tf`'s default multi-replica
autoscaling, not just a theoretical one, and there's no metric today that
distinguishes "machine not connected anywhere" from "connected to the wrong
replica." Tolerable only because nothing calls `wake()` yet and the whole
channel is spec-optional (a missed wake just means the machine waits out
its normal poll interval, same as if this channel didn't exist at all) —
revisit before wiring a real caller in a multi-replica deployment: either
pin the control plane to one replica, or replace this in-memory map with
something shared across replicas (e.g. Postgres `LISTEN`/`NOTIFY`).

### Tunnel-signal channel (CP → agent, deliberately not `wake`)

A fifth CP → agent surface, separate from the four-operation agent
protocol above: `GET /api/v1/tunnel/signal`
(`apps/control-plane/src/tunnel/signal.ts` +
`http/routes/tunnel-signal.ts` + `http/handlers/tunnel-signal.ts`),
long-polled continuously by `apps/agent/src/tunnel/signal-listener.ts`.
Its only job: tell a machine's
agent *"session `<id>` is waiting, connect now"* or *"session `<id>`,
stop"* — the minimal signal needed once a browser mints a web-terminal/SSH
session (`TunnelServer.mintSession`, `docs/access.md` §4) or a policy
disables access (`TunnelServer.terminateSessionsForMachine`), so that fact
actually reaches a connected agent instead of only updating the `sessions`
DB row.

**Why a new channel and not a repurposed `wake`:** spec §8.1 pins `wake` to
"exactly one message, pull now, with no payload — it cannot carry
instructions," and its whole purpose is accelerating the control agent's
*own* desired-state poll cycle above — an unrelated concern to "which
session is waiting." Spec §23's agent protocol is also pinned to exactly
four operations; there's no fifth slot in that group for "attach to
session X." Bolting a session id onto `wake` would violate both. See
`apps/control-plane/src/tunnel/signal.ts`'s own header comment for the
full reasoning.

**Design: a long poll, not a second websocket.** `agent-wake.ts`'s stub
exists specifically because `HttpApiEndpoint`/`HttpApiGroup` can't model a
websocket upgrade, and wiring one into this skeleton's router was judged
not worth it for `wake`. The tunnel-signal channel sidesteps that same
obstacle rather than solving it: a long poll is a plain `GET` held pending
server-side (`signal.ts`'s `TunnelSignal.next`, a `Deferred` per
in-flight call, ~25s timeout) until a signal arrives or it times out with
`signal: null` — no upgrade needed at all, so it fits `HttpApiEndpoint`
exactly like `/poll`/`/report` do, bearer-authenticated the same way
(`AgentSessionToken`).

**Re-checks the machine on every call, not just the bearer session.** A
bearer session can outlive the machine it was minted for (up to its own
~15 min TTL — no server-side revocation before then), and unlike
`poll`/`report` — which only ever hand back inert desired-state data or
acknowledge a report — this channel can actively tell an agent "a session
exists, connect to it." So `next`'s handler re-looks the machine up
(`MachineDirectory`, same as `report`'s existence/org check, plus
`attest`'s stricter archived check) on every call and refuses
(`machine_not_found`/`machine_archived`) rather than keep handing an
archived or reassigned machine's agent live tunnel signals for however
long its stale bearer session happens to still verify.

**What's real:** the control-plane service (in-memory per-machine
queue + parked-waiter wake-up, unit-tested in `signal.test.ts` including
the interrupted-long-poll cleanup path), the HTTP long-poll endpoint, and
the agent's continuous listener loop (`signal-listener.ts`, unit-tested
for message framing, malformed bodies, and backoff-on-failure). `index.ts`
runs it concurrently with the poll/report loop, with log-only callbacks —
proven end to end over a real Docker network in
`test/agent-connectivity/` (mint a session, confirm the agent's log shows
it received the signal).

**What's still a stub:** actually *acting* on the signal — opening the
reverse tunnel and attaching a real PTY session — is
`apps/agent/src/tunnel/client.ts`, a sibling unit's responsibility. This
channel only ever hands that client a bare session id; it never carries a
session token or any other detail, matching `wake`'s own no-payload spirit
even though it's a different channel.

### Poll/report loop, backoff, and jitter

`apps/agent/src/poll-report-loop.ts`: attest, poll, (reconcile locally —
currently a no-op, see above), report, sleep ~30s, repeat.

On any failure it backs off instead of retrying immediately or on a fixed
schedule:

```
backoff = random(0, min(cap, base * 2^attempt))
```

**Exponential with full jitter, ~10 min cap** (spec §8.1), implemented in
`apps/agent/src/backoff.ts` and unit-tested for the invariants that matter:
stays within `[0, min(cap, base·2^attempt)]`, and is genuinely randomized
rather than a fixed delay. The jitter is the part that matters, not the
exponential curve: the failure mode being guarded against is a
synchronised fleet-wide poll storm the moment a control-plane outage ends,
which a fixed or non-randomized backoff would reproduce exactly.

A `401` from `/poll` or `/report` (expired/invalid bearer session) clears
the cached session and re-attests next cycle without necessarily backing
off the *attestation* itself — but a join token the control plane actively
rejects (`AttestationRejectedError`) is logged loudly as needing a human,
since retrying with the same bad credential will never succeed.

### Sleeping machines and `last_verified_at`

**Never fake liveness** (spec §8.1). A machine that's been asleep — or an
agent that's been stopped, or a machine that's lost network — simply stops
reporting. `machines.last_verified_at` only ever advances when `/report`
actually runs, so it's a true "last time we heard from this machine," not
a heartbeat interpolated between real reports. The "machines are
reporting" compliance check reads this column directly rather than the
event stream, because a healthy, silent machine emits no events at all —
absence of an event is not itself an event (spec §24).

When a long-asleep machine wakes and reports again, `occurred_at` on any
event that report derives (e.g. `machine.state_reported`) reflects when
the agent actually observed the change, which can be well before
`recorded_at` (when the control plane wrote it down) — the reason those
two timestamps are separate columns at all (spec §24).

### Tampering

Root users can stop the agent, patch it, or feed it false state — this is
inherent to giving someone administrative access to their own machine, and
is not itself a compliance failure (spec §23). A stopped agent stops
reporting, which fails the "machines are reporting" check on its own,
without anyone having to notice the tampering specifically. A patched
agent that misreports state is still checkable by contradiction against
what the cloud provider independently reports — out of scope for this
unit, but the reason report bodies are treated as claims to verify (e.g.
against the `machines` row) rather than facts to trust outright.

## Tunnel daemon (spec-level only — not implemented in this build)

The second agent (spec §8.2). Not part of `apps/agent` in this build; noted
here because `docs/agents.md` is the doc that's supposed to cover it.

- A reverse tunnel over an outbound connection, carrying interactive
  sessions (web terminal, SSH) to the control plane's tunnel endpoint —
  same pull/outbound-only posture as the control agent (invariant #7).
- **TLS pass-through by default** — the control plane does not terminate
  the session's TLS itself.
- **Must terminate live sessions on a policy change**, not merely refuse
  new ones: if access is revoked or an elevation expires mid-session, the
  daemon has to actually kill the open connection, not just stop admitting
  new ones.

See `docs/access.md` for the web terminal / SSH certificate model this
daemon serves, and `docs/spec.md` §8.2/§11 for the full reasoning.
