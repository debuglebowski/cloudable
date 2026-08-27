# Machine lifecycle

Implementation detail for spec §14. Read `CLAUDE.md`'s invariants first — in particular
invariant 6 ("Machines are archived, never deleted") and invariant 5 ("Drift is flagged,
never auto-corrected" — irrelevant here except as a reminder that nothing in this
lifecycle silently "fixes" anything either).

Domain code: `apps/control-plane/src/domain/archive/*`. HTTP surface:
`apps/control-plane/src/http/routes/archive.ts` (+ handlers in `http/handlers/archive.ts`),
wire types in `packages/contracts/src/domains/archive.ts`.

## The state machine

```
       live                          archived
┌──────────────────┐   archive()   ┌────────────────────┐   expiry sweep   ┌───────────────────┐
│ provisioning      │ ────────────▶│ archived_restorable │ ───────────────▶│ archived_expired   │
│ running           │               │ (retention clock    │  (not built in   │ (volume data hard- │
│ stopped           │               │  running)           │   this unit —    │  deleted; record   │
│ error             │               │                     │   see below)     │  + audit history   │
└──────────────────┘               └────────────────────┘                  │  permanent)        │
                                                                             └───────────────────┘
```

`machines.state` only ever moves in this direction — there is no code path back to
`live`. A restore (see below) writes data/config back onto a machine; it never flips
`machines.state`. `machines` rows are never deleted (invariant 6): the two archived
states, `archivedAt`, and the full event history are permanent.

`archiveMachine(machineId, approvalId?)` (`domain/archive/archive.ts`) drives the `live →
archived_restorable` transition:

1. Calls `ProvisioningService.archive()` — the actual machine-side archive action.
2. Sets `machines.state = "archived_restorable"`, `archivedAt = now`.
3. Calls `createSnapshot(machineId, "archive")` for the final snapshot.
4. Emits `machine.archived` with `{snapshotId, retentionExpiresAt}`.

Archiving a machine directly is **not** itself on the §13 approval-consumer list —
`approvalId` is optional and only used for actor attribution on the emitted event (see
"Actor attribution" below). Offboarding (unit 16) is the approval-gated flow that calls
this primitive after obtaining its own approval.

## Sub-states

`archived_restorable` vs. `archived_expired` are real values of `machines.state`. For a
`snapshot` row (which outlives the machine and has its own retention clock — see
"Archive is separate from Machines" in `docs/frontend.md`), the equivalent distinction is
**computed, not stored**: `getSnapshotSubState()` (`domain/archive/sub-state.ts`) returns
`"restorable"` or `"expired"` purely from whether `snapshots.expiredAt` is set. There is
no separate sub-state column to drift out of sync with it.

An expired snapshot's restore is **greyed out with a stated reason, never hidden**:
`restoreUnavailableReason()` returns a human-readable sentence (`null` when restore is
available), and `restoreSnapshot()` fails with a typed `SnapshotExpiredError` carrying
that same reason rather than a bare not-found or a silent no-op. The HTTP layer maps this
to `409 Conflict`, distinct from `404` (the snapshot exists; it just isn't restorable).

## Retention clock

`retentionDays` is resolved per-snapshot at creation time via `resolveSetting()`
against the org → machine chain (there is no template layer in v1), key
`archive.retentionDays`, default **30**, org-configurable. `expiresAt =
createdAt + retentionDays`. The clock is fixed at snapshot creation — changing the org's
policy afterward does not retroactively move an existing snapshot's `expiresAt`.

A full expiry-sweep cron is **not** built in this unit. What *is* built is the query a
scheduler (or unit 9's "retention is honoured" compliance check) needs:
`computeExpirySweepCandidates(now?)` returns every snapshot where `expiresAt < now`,
`expiredAt IS NULL`, and `legalHold = false`. Actually hard-deleting the underlying
volume data and setting `expiredAt` is future work for whichever unit builds the
scheduler; this unit only guarantees the candidate query is correct and legal-hold-aware.

## Legal hold

`setLegalHold(snapshotId, reason)` / `clearLegalHold(snapshotId, reason)` toggle
`snapshots.legalHold` (+ `legalHoldReason`) and emit `snapshot.legal_hold_set` /
`snapshot.legal_hold_cleared`. Both require a non-empty `reason` — a legal hold with no
stated reason is rejected (`InvalidLegalHoldReasonError`, `400`), mirroring §13's "reason
required, never optional" rule for approvals even though a legal hold is not itself an
approval object.

A legal-hold snapshot is excluded from `computeExpirySweepCandidates()` regardless of how
far past `expiresAt` it is — the clock doesn't advance while a hold is on, it's simply
never evaluated. This renders as a **documented exception**, not an error: the snapshot
stays fully visible and restorable, just permanently exempt from the sweep until cleared.
Clearing a hold does **not** recompute `expiresAt` — the original retention window
resumes as if the hold had paused it, not reset it.

## Snapshot contents

Every snapshot captures **volume data AND the machine's desired state/configuration**
(`containsData: true, containsConfig: true` — both always true for a snapshot created by
this unit; the columns exist as booleans rather than being hardcoded so a future
snapshot type — e.g. a config-only manual snapshot — has somewhere to record that).
Region is inherited from the machine's own region, never independently chosen.

Per invariant 8 ("Cloudable never stores customer secrets"), secret bindings are
injected at runtime and never written to disk — so a snapshot's "config" never includes
secret *values*, only the *bindings* (which secret store, which pointer) a machine's
desired state declares. See "Restore modes" below for why reattaching those bindings is
treated as meaningfully more dangerous than the data/config it captures alongside them.

## Restore modes — escalating approval

`restoreSnapshot(snapshotId, mode, requestedByPersonId, targetMachineId, reason,
confirmSecretBindings?)` (`domain/archive/restore.ts`) is gated by `ApprovalService`
(unit 5) before anything happens: it always calls `ApprovalService.request({actionType:
"snapshot_restore", ...})` and only performs the restore — i.e. writes
`snapshot.restored` — once that request's `status` is `"approved"`.

**The escalation problem this unit had to solve:** approval mode (`none` / `single` /
`dual`) is policy resolved *per action type* (§13), and every restore — data, config, or
full — shares the single action type `"snapshot_restore"`. `ApprovalService.request()`
has no parameter for *which* restore mode is being requested, so the generic service
cannot by itself make a full restore harder to approve than a data-only one.

**The rule this unit implements** (`domain/archive/approval-escalation.ts`,
`resolveRestoreApprovalFloor`) sits in front of that generic gate:

| Restore mode | Approval floor | Rule |
|---|---|---|
| `"data"` | the org's own policy (`archive.restoreApprovalMode`, resolved via `resolveSetting()`, default `"none"`) | Lowest bar, unmodified — spec explicitly allows `"none"` here |
| `"config"` | org policy, floored at `"single"` | At least one approver even if the org configured `"none"` for data restores |
| `"full"` | **always `"dual"`, hardcoded** | Deliberately ignores org policy entirely — reattaching secret bindings is meant to be the hardest restore to reach, independent of whatever the org has configured for the other two modes. This satisfies the spec's "never resolves below `single`" floor trivially, by never resolving below `dual`. |

Because `ApprovalService.request()`'s payload can't carry this resolved floor
structurally, it is written into the approval's `reason` text (e.g. `"[snapshot restore |
mode=full | approval-floor=dual] <caller's reason>"`) for reviewer/audit visibility. This
is a known interface gap, not a design preference: if unit 5 (or a later revision of
`ApprovalService`) grows a way to parametrize `request()` by sub-action, the escalation
rule here should move to a real, structured parameter instead of a reason-text
convention. Until then, the floor described above is enforced independently of whatever
`ApprovalService` itself resolves for the bare `"snapshot_restore"` action type.

**`mode: "full"` never reattaches secret bindings as a byproduct.** Independent of the
approval gate above, `restoreSnapshot()` requires the caller to pass
`confirmSecretBindings: true` for `mode: "full"` — an explicit, separate acknowledgement,
never defaulted and never inferred from `mode` alone. Omitting it fails with
`FullRestoreNotAcknowledgedError` (`400`) **before an approval is even requested** — a
data or config restore can never silently escalate into reattaching secrets just because
a caller reused a request shape.

**Every restore writes an event, but only once it actually happens.** If
`ApprovalService.request()` returns:

- `"approved"` — the restore happens and `snapshot.restored` is written, with
  `{mode, targetMachineId, approvalId}`.
- `"rejected"` or `"expired"` — `restoreSnapshot()` fails with `RestoreNotApprovedError`
  (`403`). Nothing is written to `snapshot.restored` (unit 5's `ApprovalService` is
  responsible for its own `approval.denied`/`approval.expired` events).
- `"pending"` — a legitimate, non-error outcome for single/dual-mode restores awaiting a
  human decision. `restoreSnapshot()` returns `{..., restored: false}` and writes nothing
  further. Completing the restore once that decision later lands is out of this unit's
  scope — see "What this unit does not do" below.

**What "performing the restore" means in this build:** this unit validates eligibility
(not expired, acknowledgement present for `"full"`), enforces the approval gate, and
writes the permanent audit record that the restore happened. It does **not** reach into a
cloud API to reattach a volume or reapply configuration — `ProvisioningService` has no
restore-specific operation in this build (see `apps/control-plane/src/services/
ProvisioningService.ts`), and adding one is out of this unit's file scope. The mechanical
reattachment is desired-state work for the reconciliation loop once `targetMachineId`'s
desired state reflects the restored snapshot.

**What this unit does not do:** complete a restore asynchronously once a `"pending"`
approval is later decided. `ApprovalService.decide()` exists but nothing in this build
calls `restoreSnapshot()` again on a grant — that requires either a webhook/callback from
`ApprovalService` or a poller, neither of which exists yet. This is an explicit,
documented gap for a future unit to close, not a silent limitation.

## Actor attribution

`createSnapshot` and `restoreSnapshot`'s own events (`snapshot.created`) are attributed
to the `"system"` actor, since neither function's signature carries a person (both are
exact, load-bearing signatures per the cross-unit dependency note — see below). A restore
that DID complete attributes `snapshot.restored` to the person in `requestedByPersonId`
(a real input to `restoreSnapshot`). `archiveMachine`'s `machine.archived` event
attributes to the person who requested the given `approvalId`, when one is supplied
(looked up on a best-effort basis — a lookup failure falls back to `"system"` rather than
failing the already-approved archive action over an attribution nicety); to `"system"`
otherwise.

## BYOC cost estimate — not billing

An archived snapshot is a real Azure disk snapshot billed to the customer directly by
Azure for the hold period (invariant-adjacent: "Not in v1: billing... a rough sizing
estimate at creation is fine — do not call it billing"). `estimateSnapshotCost()`
(`domain/archive/pricing.ts`) is a **pure, synchronous** function:
`sizeBytes * pricePerGbPerDay * daysRemaining`, using a placeholder Azure managed-disk
snapshot price (`$0.05`/GB-month, LRS pay-as-you-go — not pulled from a live price list;
no real Azure account exists in this build). It returns `0` once a snapshot has already
reached its expiry (no remaining hold period to project).

The HTTP response (`GET /api/v1/archive/snapshots/:id/cost-estimate`) always carries a
`disclaimer` field alongside the figure. Nothing in this unit calls this feature
"billing" anywhere — in code, comments, docs, or the API shape.

`sizeBytes` itself is a placeholder (`PLACEHOLDER_SNAPSHOT_SIZE_BYTES`, ~32 GiB) set at
snapshot creation, since no `ProvisioningService` implementation in this build reports
real Azure disk usage.

## Cross-unit dependency

`createSnapshot(machineId, trigger, correlationId?)`, `archiveMachine(machineId,
approvalId?)`, and `restoreSnapshot(input)` are exact, load-bearing signatures — units 16
(offboarding) and 18 (upgrade transactionality) call them directly. `correlationId` on
`createSnapshot` is an optional third parameter (defaults to a fresh ULID), added so a
caller that is itself part of a larger operation — `archiveMachine` does this — can link
`snapshot.created` to its own event under one `correlation_id` without changing the
two-argument contract described in the feature-unit brief.

## HTTP surface

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/archive/machines/:machineId/archive` | Body: `{approvalId?}`. `404` if the machine doesn't exist, `409` if it's already archived (archiving is one-way — see "The state machine"). |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/restore` | Body: `RestoreSnapshotRequest`. `404` snapshot or target machine not found, `409` expired, `400` full-mode without acknowledgement, `403` denied/expired approval. |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/legal-hold` | Body: `{reason}`. `400` on an empty reason. |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/legal-hold/clear` | Same shape as above. |
| `GET` | `/api/v1/archive/snapshots/:snapshotId` | Returns `SnapshotView`, including computed `subState` and `restoreUnavailableReason`. |
| `GET` | `/api/v1/archive/snapshots/:snapshotId/cost-estimate` | Returns `SnapshotCostEstimateResponse`. |

All six are declared in `http/routes/archive.ts` (`ArchiveGroup`, registered in
`http/api.ts`) and implemented in `http/handlers/archive.ts` (`ArchiveLive`, registered in
`server.ts`). Errors that represent Cloudable's own infrastructure breaking (a DB
failure, `EventBus` failing to publish, `ApprovalService.request()` itself erroring —
still a unit-5 stub as of this unit landing) are converted to defects (`500`) rather than
declared wire errors; only errors meaningful to an API caller are typed and mapped to a
specific status code.

## Testing

Pure business logic (`approval-escalation.ts`, `pricing.ts`, `sub-state.ts`) has
colocated `bun:test` unit tests with no external dependencies. The DB-touching functions
(`createSnapshot`, `archiveMachine`, `restoreSnapshot`, `setLegalHold`/`clearLegalHold`,
`computeExpirySweepCandidates`) were verified end-to-end against a real Postgres
(docker-compose, port 5442) and, for the HTTP surface, via `curl` against a running
`apps/control-plane` — see the PR description for the exact scenarios exercised. An
automated `test:integration` suite via `test/testcontainers.ts` was not added: spinning
up Testcontainers under Bun's test runner in this environment hangs rather than
completing (a known Bun/Testcontainers interaction, not specific to this unit's code) —
the same limitation noted by other feature units in this build.
