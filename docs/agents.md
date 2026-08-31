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
| Wake | `GET /wake` (websocket) | Optional fast path, CP → agent. **Stub in this build — see below.** |

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

**Wake** is a stub. `HttpApiEndpoint`/`HttpApiGroup` model HTTP verbs, not
a websocket upgrade, and wiring a full upgrade path through this
skeleton's router (`@effect/platform`'s `Socket`, `platform-bun`'s
`BunSocket`) was more than this slice's time budget justified for an
operation the spec itself calls optional (spec §8.1: "optional fast
path"). What's real: the wire contract both sides agree on
(`WakeMessage` in `packages/contracts/src/domains/agent-protocol.ts`,
`{type: "pull_now"}`, no payload, and it cannot carry instructions), plus
placeholder integration points on both sides —
`apps/control-plane/src/http/routes/agent-wake.ts` and
`apps/agent/src/wake.ts` — documenting exactly what a real implementation
would do. Functionally, this just means a machine always waits out its
full poll interval to pick up a change; it never gets fed one instantly.

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
