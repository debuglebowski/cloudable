# Cloudable — Spec (reasoning behind every decision)

This is the full reasoning document referenced from `CLAUDE.md`'s docs table. `CLAUDE.md` states the
invariants and terminology; this file explains *why* each decision in the build was made, section by
section. Other `docs/*.md` files cover their area in more implementation-facing detail; this one is
the reference for "why does it work this way."

---

## 0. Invariants

Violating any of these breaks a stated customer promise. They are not preferences.

1. **No cloud credential is ever stored.** Federation only. Client secrets are never acceptable.
2. **Events are append-only.** No updates, no deletes. Retention is expiry, not mutation.
3. **A machine has exactly one owner, and the owner is a person.** No shared, team-owned or unowned machines.
4. **Reconcile only closes gaps.** It removes undeclared software; it never installs something it found running.
5. **Drift is never auto-corrected.** Detected, surfaced, aged — never silently removed.
6. **Machines are never deleted.** Only archived. Snapshot data expires; the record is permanent.
7. **No inbound network access to any machine, ever.** Agents are pull-only; tunnels are outbound.
8. **Cloudable never stores customer secrets.** It injects at runtime from the customer's own store.
9. **The CA private key never enters the control plane.** Sign operations only.
10. **Desired state is edited; live machines are not.** Reconcile is the only operation that mutates a machine.
11. **Event type names are a public interface.** Additive changes only. No renaming.
12. **The agent never submits audit events.** It reports observed state; the control plane diffs and emits. A user with root could otherwise write their own audit history.

---

## 1. Terminology

`machine` — in the API, CLI, database and UI. One word, no synonyms. "Workspace" is rejected.

Compliance evaluations are **compliance checks**, never "tests".

---

## 2. Deployment modes

| Mode | Control plane | Machines |
|---|---|---|
| Self-hosted | Customer tenant | Customer tenant |
| BYOC (default) | Cloudable-hosted | Customer tenant |
| Fully managed | Cloudable-hosted | Cloudable tenant |

Same artefact in all three. Self-hosted is the simplest deployment: one trust boundary, managed identity, no federation.

**Azure only.** No AWS or GCP.

---

## 3. Identity

SCIM 2.0 + OIDC against Microsoft Entra ID. IdP and cloud provider are independent axes.

SCIM is **not required**. With no IdP connected, Cloudable's People section is the system of record and fully editable. When SCIM is connected, synced fields become read-only with an indicator of origin.

---

## 4. Provisioning

No Terraform. Own schema, direct ARM SDK calls, reconciliation loop, operator-style. Create / archive / reconcile-if-missing over a small resource set. No plan/apply, no state file.

If ever revisited, use OpenTofu.

---

## 5. Policy inheritance

**Chain: organisation → template → machine.** The template layer does not exist in v1; the chain is organisation → machine.

Required from the first migration:
- Machines carry a **nullable `templateId`**
- Every setting carries a **`source` field** (`org` | `machine` in v1, `template` added later)

Applies to every setting: packages, access methods, logging tier, retention, approval modes, region.

**No wizard prefill of any kind.** A machine is created from org defaults. Prefill-style templates that copy values and forget their origin are rejected — that is a different data model.

Overrides render visibly with the inherited value struck through and its origin named.

---

## 6. Package manifest

An entry names a package and **optionally** pins a version. `docker` and `nodejs 20` are both valid. No dependency resolution; the machine's package manager does that.

**Resolution: lowest level wins.** Machine beats template beats organisation.

**Pinning:** the organisation can mark an entry pinned. A pinned entry cannot be overridden below. Attempting to override one is a **validation error at edit time**, not a silent no-op at reconcile.

**Scope 2:** per-machine policy disabling local installation entirely.

---

## 7. Machine model

**Disposable.** Persistent paths survive; the OS does not. An OS upgrade is: reimage, remount persistent volume, reinstall declared packages. One button.

Per machine: package manifest, persistent paths, access methods enabled, logging tier, region, one owner.

**Allowlist:** anything installed outside the manifest is detected on reconcile and surfaced.

No Ansible — push models break against ephemeral or sleeping machines. Packer baking is optional and compatible.

---

## 8. Agents

Two separate daemons. Different trust levels, different failure domains.

### 8.1 Control agent (systemd)
- On boot: attest identity, report installed packages and config state
- Pull desired state, reconcile, enforce allowlist, emit events
- **Pull-only. No inbound access ever.**
- Poll ~30s with ETag / version check
- **Backoff: exponential with full jitter, ~10 min cap.** Jitter is the part that matters — the failure mode is a synchronised fleet-wide poll after a control plane outage
- Optional fast path: outbound websocket carrying exactly one message, *pull now*, with no payload. It cannot carry instructions
- **Sleeping machines: never fake liveness.** Reconcile on wake, report `last verified at <timestamp>`

### 8.2 Tunnel daemon
- Reverse tunnel over an outbound connection for interactive sessions
- **TLS pass-through by default.** The control plane does not terminate
- **Must terminate live sessions on policy change**, not merely refuse new ones

See `docs/agents.md` for implementation detail.

---

## 9. Agent authentication

An attestation interface with two methods, both taking opaque strings:
- Agent: *give me a credential*
- Control plane: *verify this credential, return a machine identity*

Implementations:
- **Join tokens** — first-class, not a fallback. Build first. Used by local development, testing and bare metal
- **Azure managed identity** — token from IMDS, verified against the published key set. Recommended path, added second
- **Bare metal** is another provider implementation, not a special case

---

## 10. Cloud provider authentication

**Workload identity federation. Never stored credentials.**

1. Cloudable runs an OIDC issuer at a public URL (discovery document + JWKS)
2. At provisioning time it mints a short-lived token with a **per-customer subject**, e.g. `cloudable:tenant:<customer-id>`
3. The customer creates an app registration and adds a federated credential trusting that issuer **and that specific subject**
4. Azure validates and returns an access token (~1h)

> ⚠️ **The subject binding is the tenant isolation boundary.** A trust rule naming only the issuer accepts a token minted for any customer. This is a single-line mistake with cross-tenant consequences.

The signing key is Cloudable's own, in Cloudable's Key Vault. Not supplied by the customer, unrelated to the customer's IdP.

**Customer provides three non-secret identifiers:** tenant ID, application (client) ID, subscription ID. Ship a Terraform template that performs their side in one command.

**Revocation:** the customer deletes the federated credential. Unilateral, immediate.

**Scope: a custom RBAC role listing only required actions, assigned to a single dedicated resource group.** Never Contributor. Never at subscription scope.

**Fully managed mode** uses a managed identity in Cloudable's own tenant — same code path, the provisioning layer does not know the difference.

**Certificate credentials** only where federation is impossible. **Client secrets: never.**

Keep the provisioning boundary a clean interface (*"make this machine"* → *something with cloud permissions does it*) so the scope-2 in-tenant worker slots in behind it unchanged.

See `docs/cloud-auth.md` for implementation detail.

---

## 11. Access methods

Access method is policy, inherited through the chain. Contractors browser-only, employees browser plus certificates, exceptions visible as overrides.

### 11.1 Web terminal
A **plain web terminal**, not code-server. Agent installs it, keeps it running, reports health. Routed through the tunnel daemon, never a public endpoint. Admin-disablable at any level.

**Disabling terminates live sessions.**

**Session authorisation is a signed token, not tunnel trust.** The control plane mints a short-lived token carrying IdP identity, target machine and target OS user, signed via **the same Key Vault sign operation as the SSH CA**. The agent validates the signature before attaching.

> ⚠️ **The agent must validate the signature on every session, including under load.** Trusting the tunnel because it is already authenticated makes a control plane compromise equal to root on every machine in the fleet.

Browser TLS terminates at the control plane by construction — end-to-end encryption to the machine is not available on this path at any logging tier.

### 11.2 SSH certificates
`cloudable login` → browser → IdP → ~8h certificate into the user's ssh-agent.

**No public key upload at all.** Not as a fallback. The web terminal covers users who cannot install the CLI.

Consequently these do not exist and must not be built: per-key staleness clocks, 90-day access reviews, password-authentication toggles, per-machine connection passwords.

The Access surface shows only: which certificates are live, for whom, expiring when.

**CA key handling:** the control plane assembles certificate contents, calls a **sign operation** against Azure Key Vault (or Managed HSM), receives only the signature, assembles the certificate around it. The private key never enters the control plane.

### 11.3 Scope 2
Tailscale as an integration — customer credentials once, agent joins the tailnet with ACL tags per template, device cleaned up on deprovision.

See `docs/access.md` for implementation detail.

---

## 12. Secrets

**Cloudable is the injector, never the vault.** The customer points at their own store (Azure Key Vault, 1Password). Cloudable fetches and injects at runtime, per template or per user.

**Injected at runtime, never written to disk — therefore snapshots contain no secrets.**

---

## 13. Approvals

**One generic approval object**, built before any action that consumes it.

| Field | Notes |
|---|---|
| Requester | IdP identity |
| Action | Typed reference |
| Reason | Required free text, never optional |
| Approver(s) | Resolved against approval mode |
| Decision | Granted / denied / expired |
| Timestamps | Requested, decided, expires |

**Approval mode is policy**, inherited through the chain, per action type: **none / single / dual**.

Consumers: snapshot restore, break-glass, admin access to an unowned machine, offboarding.

Every decision writes an event, granted or denied. Denials are evidence.

A confirmation dialog is self-approval and is not an approval.

---

## 14. Machine lifecycle

**`live → archived`.** Machines are never deleted.

### Archived sub-states
- **Archived, restorable** — volume detached and snapshotted, retention clock running, restore available subject to approval
- **Archived, expired** — clock elapsed, volume data hard-deleted. **Record and full audit history persist permanently.** Restore greyed out with a stated reason, never hidden

Retention default 30 days, org-configurable. **Legal hold** flag exempts a volume from expiry and renders as a documented exception, not an error. Snapshot region inherits the machine's region.

### Snapshot contents
Volume data **plus** machine desired state and configuration.

### Restore modes — escalating approval
1. **Data only** — default
2. **Config only**
3. **Full, including secret bindings** — deliberately hardest to reach

Never silently reattach secret bindings. Every restore writes an event.

### Ownership
Exactly one owner, always a person. No shared, team-owned or unowned machines.

### Offboarding
Approval-gated action: revoke live certificates, stop machine, clear owner, move to archived, start retention clock.

**Build the action first, wire the trigger later.** SCIM changes the trigger from a human to a webhook; it does not change the action. It must work with a human pressing it.

### BYOC cost
An archived snapshot is a real Azure disk snapshot billed to the customer for the hold period. **Surface projected snapshot cost on the Archive page.**

See `docs/lifecycle.md` for implementation detail.

---

## 15. Admin access & break-glass

Implemented in Cloudable, **not** Entra PIM. One elevation primitive on the generic approval object.

**Admin connecting to a machine they do not own:** org policy of **never / always / with approval**.

If allowed: reason required, time-boxed grant (e.g. 1h) that expires on its own, owner notified, session recorded, event written.

**Two elevation levels with separate approval requirements:**
- **File recovery** — lower risk
- **Interactive shell** — can read injected secrets on a live machine

---

## 16. Configuration management

Admins edit **desired state**, never a live machine. Editing desired state is inert and instant. The agent applies on next reconcile.

Reconcile is the only operation that mutates a machine, and it is confirmation-gated.

Same path whether the change came from the UI or a Git commit.

---

## 17. Logging

Per-template tier; cost follows.

1. **Metadata only** — provisioning, auth, lifecycle
2. **Session-level** — connections, elevations, config changes
3. **Full command capture**

**Tier 3 has a stated consequence sold at purchase: Cloudable is on the plaintext path.** Tiers 1 and 2 are honest because the tunnel passes TLS through.

**Retention location:** customer-controlled or Cloudable-held. Cloudable-held logs reside in **Sweden Central** — single org-wide value, no per-machine setting. Residency changes are a DPA matter, not a toggle.

**Volume control:** log state *changes*, not state confirmations. Successful no-op reconciles from thousands of agents polling every 30s will otherwise dominate everything else.

---

## 18. Evidence model

**Store raw provider events untouched. Project a normalised view on top.**

- Auditors read the projection. A normalised `denied access event` satisfies the control
- Forensics reads the raw layer
- Never destroy the source

Cloud-specific detail is exposed as extensions alongside the normalised contract.

---

## 19. Compliance surface

Computed live from current fleet state, not stored.

### Three layers
- **Events** — facts Cloudable emits. Not interpretations, never customer-configurable
- **Checks** — procedures run over events, evaluated continuously
- **Controls** — judgements about what a check evidences. Customer-owned

One check can evidence several controls; one control usually needs several checks. Many-to-many.

### Event catalogue
**Published in full** — every event type with its fields and semantics. Customers cannot map against events they cannot see.

**Therefore event types are a public versioned interface:** additive changes only, no renaming, deprecation with notice. From the first release.

### Control mapping
**Organisation-level configuration, overridable per control.** Cloudable ships defaults for the controls it is itself audited against — access management and asset management clauses. Customers adjust for their own framework or auditor.

Most of ISO Annex A (physical security, HR screening, supplier contracts) has no bearing on the product and must not be claimed as evidenced.

### The v1 checks

| Check | Fails when |
|---|---|
| Access revoked on offboarding | A certificate is still valid 24h after the owner was offboarded |
| Machine has an active owner | Owner absent from the IdP or deactivated |
| No undeclared software | Installed packages diverge from the resolved manifest |
| Elevated access was approved | A break-glass or admin session has no approval record and reason |
| Retention is honoured | A snapshot outlives its retention window without a legal hold |
| Machines are reporting | `last verified at` older than the expected reconcile window |

**Six is a starting set, not a ceiling.** Unimplemented checks display as *not covered*.

### Checks are applicability-gated
A check is only asked where it makes sense — by machine type, org policy and current state. Dashboards full of `N/A` train people to ignore them.

### Finding age
Each open finding persists a first-seen timestamp and displays as *open 14d*. Surface median age and trend across the audit window, not just the current count.

### Control map
Maps each control to framework, requirement and honest status: **implemented / manual action required / not covered**.

### Evidence export
Grouped **by control**, not by time.

### Exports
Asset inventory CSV (owner, encryption, drift, patch status). Open findings CSV (control, severity, open-since).

### Upgrades are transactional
**Snapshot → apply → verify declared state → roll back to the pre-upgrade snapshot on verification failure.**

A failed attempt resets the due-date clock exactly as a success does, so a persistently failing machine backs off a full interval instead of retrying every cycle. Failure deep-links to the drift view.

See `docs/compliance.md` for implementation detail.

---

## 20. Console structure

- **Operate:** Machines, Templates *(scope 2)*, People
- **Govern:** Approvals (badged queue), Audit, Archive
- **Configure:** Integrations, Organisation

Deliberate omissions:
- **No Policies section.** A third place to set the same value breaks the inheritance story
- **No Secrets section.** Cloudable is not the vault; the nav item signals the opposite
- **Audit is one section with two in-page views** — admin timeline, auditor evidence export — not two nav entries

**Archive is separate from Machines.** Snapshots outlive machines and carry their own retention clock. The Machines page shows archived rows behind a filter; the Archive section governs retention.

**People is top-level and fully editable.** SCIM is not assumed.

### LineageGutter
Exactly three props:

```ts
type Level = 'org' | 'template' | 'machine'

interface LineageProps {
  source: Level              // where the effective value was set
  viewing: Level              // which level is being viewed
  overriddenBelow?: number   // count of machines overriding this
}
```

Everything else derives. **Needing a `variant` prop means the inheritance model has a hole in it.**

See `docs/frontend.md` for implementation detail (tokens, routing/nav conventions, component contracts).

---

## 21. Do not build

| | Reason |
|---|---|
| Billing, budget caps, spend history | Azure bills BYOC customers directly; any Cloudable figure disagrees with the real invoice. A rough sizing estimate at creation is fine — do not call it billing |
| Per-machine verification codes / connect-time 2FA | A second, weaker auth system beside the customer's IdP. Step-up belongs in conditional access |
| Per-machine connection passwords | A long-lived shared secret resident on the machine |
| SSH public key upload | Certificates replace it entirely |
| Shared, team-owned or unowned machines | Breaks offboarding, ownership checks and break-glass notification |
| Auto-correcting drift | A tool that deletes an engineer's packages gets routed around |
| code-server or any full IDE | Owning an IDE's update cadence and vulnerability surface |
| Idle suspend / cost optimisation | Lowers a bill, does not unlock a customer |
| General application hosting | Competing with Kubernetes and Vercel |
| Consumer/homelab templates | Wrong signal to the buyer evaluating for 200 people |
| AWS / GCP support | Azure only |
| Owning hardware | Forfeits inherited certifications |

---

## 22. Build order

1. Control plane schema + reconciliation loop (Azure SDK, no Terraform). Settings carry `source`; machines carry nullable `templateId` from the first migration
2. Control agent with **join token** attestation, end to end
3. **Generic approval object** — before any action that consumes it
4. **One compliance check end to end** — *access revoked on offboarding*. Forces event fields, query, finding age and control mapping through the whole stack before the other five are built against an unvalidated shape
5. Package manifest, desired state, allowlist detection
6. **Cloud provider federation** — OIDC issuer, per-customer subject, customer-side Terraform template
7. Azure managed identity attestation
8. Tunnel daemon + web terminal, with signed session tokens and termination on policy change
9. SSH CA with Key Vault sign operations + `cloudable login`
10. SCIM/OIDC provisioning
11. Logging tiers + normalised evidence projection. Event catalogue published and versioned from first release
12. Archive lifecycle, snapshots, restore modes, offboarding
13. Elevation / break-glass
14. Remaining five compliance checks, finding age, control map, exports
15. Config editor + GitOps
16. *Scope 2:* template layer
17. *Scope 2:* Tailscale
18. *Scope 2+:* in-tenant provisioning worker

This monorepo's v1 batch covers steps 1-15 against a fake/local Azure and Key Vault (no real Azure
account exists in this build — see `docs/cloud-auth.md` and `docs/access.md`), excludes steps 16-18,
and excludes the separate `cloudable-deploy` repository entirely (see `SCOPE.md`).

---

## 23. Agent protocol

Outbound HTTPS, agent-initiated, ~30s interval with jitter. Four operations, nothing else.

| Operation | Direction | Purpose |
|---|---|---|
| Attest | Agent → CP | Exchange platform credential for a machine identity |
| Poll | Agent → CP | Fetch desired state. ETag / version check; `304` when unchanged |
| Report | Agent → CP | Submit **observed state** after reconciling |
| Wake | CP → Agent | Optional websocket. One message, *pull now*, no payload |

### The control plane derives events; the agent does not submit them

The agent reports what it observes. The control plane compares against last-known state and emits the resulting events itself.

**A user with root on their own machine can patch the agent binary.** If the agent posted events, that user would author their own audit history — and they are precisely the person the compliance checks exist to catch. Deriving events server-side means `machine.drift_detected` is an assertion Cloudable makes, not a claim the machine submits.

A compromised machine can still misreport state. It cannot fabricate a clean history, and misreported state is detectable by contradiction — an agent reporting no change while the cloud provider shows a resized disk is itself a signal.

**Two exceptions, both emitted by the receiver rather than the agent:**
- **Session events** — the agent alone knows when a terminal session opened and closed, but the control plane minted the session token, so a session the agent reports that Cloudable never authorised is a high-severity alert rather than a log line
- **`agent.attestation_failed`** — emitted by the control plane, which is the party doing the rejecting

### Tampering is detected, not prevented

Root users can stop the agent, patch it, or feed it false state. This is inherent to giving someone administrative access to their own machine and is not a compliance failure — auditors expect tampering to be *detected and documented*, not made impossible.

A stopped agent stops reporting, which fails the *machines are reporting* check. A patched agent contradicts what the cloud provider reports.

**Claim accordingly:** *"we detect and report deviations from declared state"* is accurate and satisfies the control. *"We enforce software policy"* is not, while a root user can disable enforcement. The control map's *manual action required* status exists for exactly this.

Scope 2's local install lockdown is the stronger control where it is warranted.

See `docs/agents.md` for implementation detail.

---

## 24. Event catalogue

The public versioned interface. Every event has at least one consumer; nothing is emitted speculatively. The full, generated, always-current listing lives at `docs/events.md` (generated from `packages/events` — do not hand-edit that file).

### Envelope

Present on every event, regardless of type. These are real columns, not payload keys — every compliance check filters on them.

| Field | Notes |
|---|---|
| `id` | ULID. Sortable by creation, no coordination needed |
| `type` | e.g. `machine.archived`. Immutable once published |
| `occurred_at` | When the fact happened |
| `recorded_at` | When the control plane wrote it |
| `org_id` | Tenant scope. Never null |
| `actor_type` | `person` \| `system` \| `agent` \| `idp` |
| `actor_id` | Null when `actor_type` is `system` |
| `machine_id` | Null for org-scoped events |
| `correlation_id` | Links every event produced by one operation |
| `schema_version` | Per event type, starts at 1 |
| `payload` | JSONB. Type-specific fields only |

**`occurred_at` and `recorded_at` are separate because sleeping machines report late.** An agent that wakes after four hours reports facts that occurred four hours ago. Collapsing these makes every compliance timing check wrong for exactly the machines most likely to fail one.

**`actor_type` distinguishes human from automation.** "Who did this" is the central compliance question, and *the system did it on a schedule* is a materially different answer from *a person did it*. Deriving this later from a null actor is guesswork.

Indexed on `(org_id, type, occurred_at)`.

### Naming

`domain.thing_happened` — lowercase, dotted, verb in past tense. Events are facts that already happened; nothing is named as a command or an intention.

**Never renamed.** Adding a field is additive and permitted. Changing a field's meaning requires a new event type and deprecation of the old one with notice.

### Tiers

The tier column in `docs/events.md` is the **minimum** logging tier at which an event is emitted. Tier 1 events are always emitted regardless of configuration — they are the compliance floor, and disabling them would make the checks unanswerable.

> ⚠️ **`access.command_recorded` should not share a table with everything else.** At tier 3 it is orders of magnitude higher volume than the rest of the catalogue combined, and a single high-churn event type will dominate the index that every compliance check depends on. Separate store (`accessCommandRecorded` in `packages/schema`), same envelope, referenced by `correlation_id`.

### What is not an event

Reads and page views. Successful no-op reconciles. Poll requests. Anything emitted per-tick rather than per-change.

**Log state changes, not state confirmations.** Thousands of agents polling every 30 seconds will otherwise bury the catalogue in evidence that nothing happened.

### Check → event mapping

| Check | Consumes |
|---|---|
| Access revoked on offboarding | `machine.offboarded`, `access.certificate_issued`, `access.certificate_revoked` |
| Machine has an active owner | `machine.owner_assigned`, `machine.owner_cleared`, `person.deactivated` |
| No undeclared software | `machine.drift_detected`, `machine.drift_resolved` |
| Elevated access was approved | `access.elevation_granted`, `approval.granted`, `approval.denied` |
| Retention is honoured | `snapshot.created`, `snapshot.expired`, `snapshot.legal_hold_set` |
| Machines are reporting | **Current state, not events** — see below |

> ⚠️ **"Machines are reporting" is not a query over the event stream.** It reads `last_verified_at` on the machine row, because the absence of an event is not itself an event and a healthy machine emits nothing. Checks read current state *or* events; most read events.

---

## 25. Stack

**TypeScript and Bun everywhere for v1.** One language across control plane, agent, CLI and frontend. The velocity gain at six people outweighs the per-component optimum.

| Component | Stack |
|---|---|
| Control plane | TypeScript, Bun, Effect v3, Drizzle, PostgreSQL, BetterAuth |
| Agent | TypeScript, Bun, compiled via `bun build --compile` |
| CLI | TypeScript, Bun, compiled via `bun build --compile` |
| Frontend | React, Vite, TanStack Router + Query, shadcn/ui, Tailwind |

**Not Next.js.** No SSR requirement, and a static bundle plus an API is materially simpler for a self-hoster than deploying a Node server.

**Effect's typed errors matter here specifically.** Reconciliation is a long chain of fallible cloud calls where *what went wrong* is an audit fact, not a log line.

### Type sharing
The CLI is a client of the control plane's API and **shares its types directly from source** — no generation step (`packages/contracts`).

The agent gets **generated/type-only types for the small surface it uses**: poll response, state report, attestation, events. Keep that boundary narrow; it is the only place types are translated, and it is also the boundary a future port has to cross.

### Agent: revisit triggers, not intentions
Bun was chosen over Go knowing the trade. A port is contained *only if the agent's dependency surface stays thin* — stdlib-equivalent HTTP, one JWT library, no framework. If it accrues npm packages, the decision quietly becomes permanent.

Revisit when any of these is true:
- Binary size exceeds ~120MB
- Resident memory grows measurably across a week of continuous polling
- The first ARM machine size ships and cross-compilation is friction

**Verified in this build:** `bun build --compile --target=bun-linux-arm64` does cross-compile from a non-Linux/ARM host (see `apps/agent`, `apps/cli`).

### Testing
Testcontainers for PostgreSQL. A **fake cloud provider implementation** behind the provisioning interface, so most tests never touch Azure (`apps/control-plane/src/services/ProvisioningService.fake.ts`).

> ⚠️ **Two invariants are invisible to "does it work when I run it".** A federated credential missing its subject binding provisions machines correctly all day. An agent skipping signature validation attaches sessions fine. Both need a test that asserts the *failure* — a token minted for tenant A must be **rejected** by tenant B's trust rule; a session token with a broken signature must be **refused** — written first and failing before it passes. See `docs/cloud-auth.md` and `docs/access.md`.

### Packaging and distribution
- Control plane: one container image, published to GHCR
- Agent and CLI: versioned binaries on GitHub releases
- **No Helm chart in v1.** The control plane is one stateless container plus PostgreSQL — Azure Container Apps or Compose. Write a chart when a self-hoster asks; it will be a better chart for having been asked

### Customer-facing artefacts
The three things a customer executes in their own tenant:

1. **Federated credential setup** — app registration, trust rule, custom RBAC role assignment. Every BYOC customer runs this once
2. **Control plane deployment** — self-hosters only
3. The documentation accompanying both

**Terraform only — no Bicep.** The rejection of Terraform above applies to provisioning machines — hundreds of independently-lifecycled instances with state files and drift. It does not apply to one-shot infrastructure a customer runs occasionally, which is what Terraform is good at, and most infrastructure teams already have it in their pipeline. A one-click alternative format was considered and dropped: this project is open source and self-hosted only, and a second IaC format to keep in sync is maintenance cost without a paying-customer onboarding-friction problem to justify it.

Use **OpenTofu** in Cloudable's own CI to stay licence-clean; publish HCL that works with either.

---

## 26. Repository layout

Monorepo, Bun workspaces, MIT.

```
cloudable/                    (this repo — currently private)
  apps/
    control-plane/            API, reconciliation loop, event derivation
    console/                  React + Vite frontend
    agent/                    systemd daemon
    cli/                      cloudable login, machine management
  packages/
    events/                   event catalogue — single source of truth
    contracts/                API request/response types
    schema/                   Drizzle schema + migrations
  infra/
    terraform/
      federated-credential/   customer runs this
      control-plane/          self-hosters run this
  docs/
  SCOPE.md
```

`apps/` is things that run; `packages/` is things imported. The CLI shares `contracts/` directly from source; the agent consumes a deliberately narrow slice.

### `packages/events` enforces the public interface

The catalogue is a versioned public interface, so it exists **once** — type definitions, payload metadata and generated documentation all from the same source.

A snapshot test (`packages/events/src/__tests__/catalogue.snapshot.test.ts`) fails when an event type is removed or renamed. This converts "additive only" from a rule someone must remember into one the build enforces.

### `cloudable-deploy` — separate, private

Holds Terraform values and **image digests, pinned by SHA rather than tag**. A tag can be repointed upstream, which makes *"what is running right now"* unanswerable — and that question is the whole of change management.

It must be a separate repository: merging it into the public monorepo means either the config becomes public or the code becomes private. **This repository does not exist in this build** — it is out of scope for this batch (see `SCOPE.md`).

### Minimum internal compliance posture

Cloudable running in Cloudable's own tenant is privileged internal infrastructure — same tier as CI, not the same tier as a wiki. See `.github/workflows/` for the vulnerability-scanning and packaging posture implemented in this build.

---

## 27. Frontend tokens

Licence: MIT. See `docs/frontend.md` for the full implementation — tokens, fonts, density overrides,
and the four custom component contracts (`LineageGutter`, `Freshness`, `SettingRow`,
`ControlStatus`) — this section states only the rationale: shadcn/ui defaults produce a generic
admin dashboard; the retheme in `docs/frontend.md` is the actual design, chosen for a
200-row-table-heavy audit product rather than a marketing site.
