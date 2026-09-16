# Machine lifecycle

How machine lifecycle is implemented. Machines are archived, never deleted, and drift is
flagged, never auto-corrected — nothing in this lifecycle silently "fixes" anything either.

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
`machines.state`. `machines` rows are never deleted: the two archived
states, `archivedAt`, and the full event history are permanent.

`archiveMachine(machineId, approvalId?)` (`domain/archive/archive.ts`) drives the `live →
archived_restorable` transition:

1. Calls `ProvisioningService.archive()` — the actual machine-side archive action.
2. Sets `machines.state = "archived_restorable"`, `archivedAt = now`.
3. Calls `createSnapshot(machineId, "archive")` for the final snapshot.
4. Emits `machine.archived` with `{snapshotId, retentionExpiresAt}`.

Archiving a machine directly is **not** itself on the approval-consumer list —
`approvalId` is optional and only used for actor attribution on the emitted event (see
"Actor attribution" below). Offboarding (unit 16) is the approval-gated flow that calls
this primitive after obtaining its own approval.

## Sub-states

`archived_restorable` vs. `archived_expired` are real values of `machines.state`. For a
`snapshot` row (which outlives the machine and has its own retention clock — see
"Archive is separate from Machines" in `docs/frontend.md`), the equivalent distinction is
**computed, not stored**: `getSnapshotSubState()` (`domain/archive/sub-state.ts`) derives
it from the row — `capturedDisks`, `expiredAt`, `dataMissingAt` — rather than from a
column of its own that could drift out of sync. See "Snapshot integrity" below for the
four values and their precedence.

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

The sweep **is** built: `expiry/daemon.ts` runs `expireOverdueSnapshots` on a 60s
leader-elected loop, over the candidates `computeExpirySweepCandidates(now?)` returns
(every snapshot where `expiresAt < now`, `expiredAt IS NULL`, `legalHold = false`).

What it does **not** do is hard-delete anything in Azure. It sets `expiredAt` and
publishes `snapshot.expired`, and that is all. So a snapshot past its retention window
reads as expired in the console and in evidence while the managed-disk snapshot is still
sitting in the subscription. Check #5 ("retention is honoured",
`compliance/checks/retention-honoured.ts`) treats `snapshot.expired` as proof that
"hard-deletion happened on schedule" — it is not, and the check goes green over a
deletion that never happened. Closing that needs a provisioning-side delete and a
recorded provider id per snapshot to aim it at; neither exists yet. Known gap, and a
real one — this paragraph previously claimed the whole sweep was unbuilt, which was
also false.

## Legal hold

`setLegalHold(snapshotId, reason)` / `clearLegalHold(snapshotId, reason)` toggle
`snapshots.legalHold` (+ `legalHoldReason`) and emit `snapshot.legal_hold_set` /
`snapshot.legal_hold_cleared`. Both require a non-empty `reason` — a legal hold with no
stated reason is rejected (`InvalidLegalHoldReasonError`, `400`), mirroring the "reason
required, never optional" rule for approvals even though a legal hold is not itself an
approval object.

A legal-hold snapshot is excluded from `computeExpirySweepCandidates()` regardless of how
far past `expiresAt` it is — the clock doesn't advance while a hold is on, it's simply
never evaluated. This renders as a **documented exception**, not an error: the snapshot
stays fully visible and restorable, just permanently exempt from the sweep until cleared.
Clearing a hold does **not** recompute `expiresAt` — the original retention window
resumes as if the hold had paused it, not reset it.

## Taking a snapshot on purpose

`POST /api/v1/archive/machines/:machineId/snapshots`, or `cloudable snapshots take
<machine>`. `createSnapshot` has supported `trigger: "manual"` since it was written and
nothing ever called it — the only ways to produce a snapshot were archiving a machine or
upgrading it, both destructive. So "keep a copy before I do something" and "let me look at
what is on here" were impossible without tearing the machine down.

Defaults to `scope: "shallow"`: a snapshot taken deliberately is nearly always about the
data, and the persistent volume is the whole of what cannot be rebuilt.

**Never quiesced.** Stopping someone's running machine to take a snapshot they asked for
would be a worse surprise than a crash-consistent copy — which is what pulling the power
gives you, and what ext4 journals for. `archiveMachine` still quiesces, because there the
machine is going away anyway.

## Snapshot contents

A snapshot is a real copy of real disks. `createSnapshot` calls
`ProvisioningService.snapshot()` and records what comes back — the provider's own id for
each copy, and the real total size. It did not always: it used to insert a row and stop
there, stamping every row with a hardcoded 32 GiB, which is why the console showed the
same "34.4 GB" against every snapshot in the system and why six rows in production stand
against two actual Azure objects.

**`scope` — what was captured:**

| Scope | Disks | Use |
|---|---|---|
| `full` | OS disk + persistent disk | The machine can be put back exactly as it was. Always used for archive: the machine is going away, so there is no later chance. |
| `shallow` | persistent disk only | Smaller and faster. `/home` is on the persistent disk, so this is a complete copy of the part that cannot be rebuilt, not a lesser copy of the same thing. |

Do not confuse this with `snapshot.restored`'s `mode` (`data` / `config` / `full`), which
is what a RESTORE writes back. They share the word "full". A `shallow` snapshot can never
serve a `full`-mode restore, because there is no OS disk in it.

`capturedDisks` holds one entry per copied disk (`kind`, `externalId`, `sizeBytes`). An
empty array means the provider copied nothing — a machine whose infrastructure was already
gone, or the docker adapter, which has no disks to copy. Such a row can neither be
restored from nor deleted at expiry, and `containsData` is false to say so. Every row
written before this change has an empty array.

`containsConfig` stays true regardless of scope: the machine's desired state lives in this
database, not on either disk.

**`quiesce` — whether the machine was stopped first.** Archive stops the machine and gets
a clean copy. An upgrade cannot — the machine has to stay up until `reimage` replaces
it — so a pre-upgrade snapshot is crash-consistent, the same guarantee as pulling the
power cord. It is a parameter at the call site rather than a decision buried in the
adapter, because it is what someone needs to know when a restore comes back unclean.

Region is inherited from the machine's own region, never independently chosen.

**Ordering: snapshot first, then tear down.** `archiveMachine` copies the disks before
`ProvisioningService.archive()` deletes anything. It used to run the other way round. Both
orderings can fail, and this one fails safely: a copy plus a live machine is something
reconcile can finish, while a deleted machine and no copy is not recoverable by anything.

Cloudable never stores customer secrets: secret bindings are
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
`dual`) is policy resolved *per action type*, and every restore — data, config, or
full — shares the single action type `"snapshot_restore"`. `ApprovalService.request()`
has no parameter for *which* restore mode is being requested, so the generic service
cannot by itself make a full restore harder to approve than a data-only one.

**The rule this unit implements** (`domain/archive/approval-escalation.ts`,
`resolveRestoreApprovalFloor`) sits in front of that generic gate, expressed as a MINIMUM
mode per restore mode:

| Restore mode | Approval floor | Rule |
|---|---|---|
| `"data"` | `"none"` (no floor) | The org's own policy (`approval_mode:snapshot_restore`, `ApprovalService`'s own setting, default `"single"`) applies unmodified — spec explicitly allows this to resolve as low as `"none"` if the org configures it that way |
| `"config"` | `"single"` | At least one approver even if the org configured `"none"` for `approval_mode:snapshot_restore` |
| `"full"` | **always `"dual"`, hardcoded** | Deliberately ignores org policy entirely — reattaching secret bindings is meant to be the hardest restore to reach, independent of whatever the org has configured for the other two modes. This satisfies the spec's "never resolves below `single`" floor trivially, by never resolving below `dual`. |

The resolved floor is passed to `ApprovalService.request()` as `requiredModeFloor` and
enforced there structurally: the org's configured mode is clamped UP to this floor,
never down, so `"full"` always resolves to `"dual"` — and `"config"` always to at least
`"single"` — no matter how permissively the org has configured
`approval_mode:snapshot_restore`. An earlier revision of this unit could only stuff the
resolved floor into the approval's `reason` text for audit visibility, since
`ApprovalService.request()`'s payload had no way to carry it structurally — that gap is
closed; `requiredModeFloor` is a real, enforced parameter now. It's the same FLOOR
concept `domain/elevation/policy.ts`'s `requiredApprovalModeFloor` uses for
`admin_access`'s `shell` level, but enforced differently: that unit pre-checks the org's
configured mode and hard-refuses the request outright if it doesn't already satisfy the
floor, while `requiredModeFloor` here clamps the mode up automatically so the request
always proceeds at (at least) the floor rather than being rejected.

Restore also no longer resolves its own, separate copy of "the org's
policy" via `archive.restoreApprovalMode` — that setting was dead (read but never
written, and its own default disagreed with `ApprovalService`'s) and has been removed;
`approval_mode:snapshot_restore` (resolved inside `ApprovalService.request()` itself) is
the only real gate.

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

## Where a machine's files live — and the one-off migration

`/home` is a mount of the machine's **data disk**, not a directory on the OS disk.
This matters because `reimage` (OS upgrade) deletes the VM and its OS disk and
re-attaches the same data disk. Anything on the OS disk is gone at every upgrade,
by design — "persistent paths survive; the OS does not" (`docs/spec.md` §97).

It did not always work that way. Until this landed, the data disk was formatted,
mounted at `/mnt/cloudable-data`, and read by nothing in the entire repo, while
`/home/cloudable` — created by Azure from `osProfile.adminUsername` — sat on the OS
disk. So an upgrade destroyed the person's work and carefully preserved an empty
volume. Production hit this on 2026-09-14 (`machine.reimaged`, machine `54e3cdde`).

The boot-time half is `homeVolumeSection()` in `services/ProvisioningService.azure.ts`,
which is exported precisely so this runbook quotes one source of truth. Read it before
running any of the below.

### Machines provisioned before this change

**Do not `reimage` such a machine until it has been migrated.** The fix takes effect
on a disk that does not exist yet, so shipping it does not rescue existing data — the
upgrade still deletes the OS disk, and the new boot script then mounts an empty data
disk over `/home`. Migrate first, upgrade after.

This is break-glass remediation of a defect, not a new pattern: invariant 10 ("desired
state is edited; live machines are not") still stands. Warn the person first — their
session is killed partway through.

Reach the machine with `cloudable connect <machine>`, which lands a `cloudable` shell
with passwordless sudo. The migration must stop `cloudable-tunnel-daemon`, which is the
very session running it, so it cannot live in that session's process tree. `systemd-run`
puts it in a transient unit outside the session cgroup — that is the whole trick:

```bash
sudo systemd-run --unit=cloudable-home-migrate --collect \
  --property=Type=oneshot --property=TimeoutStartSec=infinity \
  --property=StandardOutput=append:/var/log/cloudable-home-migrate.log \
  --property=StandardError=append:/var/log/cloudable-home-migrate.log \
  /bin/bash /var/tmp/migrate-home.sh
```

The session dies partway through. Reconnect after the reboot and read the log.

The script is `scripts/migrate-home-to-data-disk.sh` in this repo, not pasted here —
it was inline once and that is exactly how a runbook drifts from the thing it describes.
Its own header carries the run instructions.

The reboot is strongly recommended rather than strictly required. It is the only thing
that proves the fstab entry and the daemon's `RequiresMountsFor=/home` ordering actually
work, and you want to learn that while `/home.pre-cloudable` is still sitting on the OS
disk rather than at the next unplanned reboot. The daemon is already down, so the
incremental downtime is one boot.

**Leave `/home.pre-cloudable` alone** until the person confirms their files are intact,
then remove it by hand. It is free (a rename, not a copy) and it is the only backup.
It is destroyed by the next reimage regardless.

**One lossy edge, tell the person in advance:** `pkill -u cloudable` kills a detached
tmux or editor, so unsaved in-memory state is lost. Files on disk are captured by pass 2.

## Snapshot integrity — does "restorable" mean anything?

`detectMissingSnapshotData()` (`domain/archive/snapshot.ts`) reads every unexpired
snapshot's `capturedDisks` and asks the provider whether each recorded object still
exists. It rides the same leader-elected loop as expiry but on a **30-minute** clock of
its own: it is the only sweep there that leaves Postgres, and at a minute's cadence a
fleet with a thousand snapshots would sustain tens of ARM reads a second forever. Disks
vanishing is a same-day concern, not a same-minute one. Rows where one does not get `dataMissingAt`
stamped and a `snapshot.data_missing` event.

**Why this is not paranoia.** A row names its copies by `CapturedDisk.externalId`, and
until this nothing ever re-read those ids. Production had two rows pointing at objects
since replaced or cleaned up, both still reading `restorable` with a live Restore button.
Pressing it would have gone through approval — up to dual sign-off — to restore nothing.

It is the third time this class of bug has been fixed. The first two taught
`getSnapshotSubState` more about the ROW: it captured nothing (`empty`), its retention
elapsed (`expired`). This one cannot be learned from the row at all — only the provider
knows the object is gone — so it needs a sweep rather than a better pure function.

**`data_missing` is not `expired`, and the difference is the whole point.** Expiry means
the data was deleted ON SCHEDULE and is evidence retention worked. `data_missing` means it
went away while the retention window was still open and nothing recorded why. Reporting
one as the other would turn a retention failure into proof of a retention success.

| Sub-state | Means |
|---|---|
| `restorable` | Disks recorded, and the provider still has them |
| `empty` | Nothing was ever captured |
| `expired` | Retention elapsed; data deleted on schedule |
| `data_missing` | Data gone early, cause unknown |

Precedence is `empty` → `expired` → `data_missing` → `restorable`. Expiry outranks
`data_missing` because past the window the data being gone is the expected outcome, and
re-reporting it as a fault would bury the anomalies.

**Flags, never corrects** (invariant 5). `dataMissingAt` is a first-observation stamp and
nothing else on the row is touched — `capturedDisks` keeps the ids that went missing,
because "which object did we lose" is the first question anyone investigating asks. A
provider that cannot answer is treated as "present" and retried next pass: flagging on a
transient failure would put a permanent, wrong mark on a healthy snapshot, and the stamp is
never cleared.

`restoreSnapshot()` refuses a `data_missing` snapshot with `SnapshotDataMissingError`
(409) before requesting an approval, for the same reason it refuses an empty one: a
restore must not consume dual sign-off to put back data that is not there.

**Known gap.** Compliance check #5 ("retention is honoured") does not yet read this. It
treats `snapshot.expired` as proof that deletion happened on schedule, and a snapshot whose
data vanished early is the opposite failure — data that should have been retained was not.
The event and the column now exist to build that on; the check has not been changed.

## Snapshot inspection — reading a snapshot's files

Domain code: `domain/archive/inspect.ts`, `inspect-authorization.ts`,
`inspection-registry.ts`. The reader itself is `apps/control-plane/src/snapshot-fs/`.

Opening an inspection gives a time-boxed, **read-only** session over the snapshot's
persistent disk. It exists for the case the rest of this document creates: someone leaves,
offboarding archives their machine, and a file only they had is now inside a snapshot with
no way to reach it short of the Azure portal — outside Cloudable and outside the audit
trail.

### The gate, and why it is not the one live access uses

`isAuthorizedToInspectSnapshot` looks almost exactly like
`tunnel/access-authorization.ts`'s `isAuthorizedForInteractiveAccess`. The difference is
one line, and it is the whole reason this is a separate function.

The live gate opens with:

```ts
if (input.ownerPersonId === null || input.ownerPersonId === input.personId) {
  return Effect.succeed(true);
}
```

A null owner means "allow anyone in the org". That is correct for what it guards — a
machine mid-provisioning or mid owner-reassignment must not become unreachable to
everyone, and a live machine always has exactly one owner.

Here it would be a hole. `offboardPerson.ts` clears the owner and **then** archives, so
every snapshot offboarding produces belongs to a machine whose `ownerPersonId` is null.
Reusing that gate would mean any member of the org could read a departed colleague's home
directory with no elevation, no approval and no reason recorded.

It is masked today only because `mintSession` refuses any machine that is not `running`.
Inspection works precisely on archived machines, so it removes the mask.

**For a snapshot, a null owner is closed.** It means "offboarded", not "not yet assigned",
and the people who may still look are the ones who went through elevation to get there.
`inspect.test.ts` pins both gates side by side on the same offboarded machine and asserts
they disagree, so anyone who later merges them gets a failure that explains itself.

Who may look:

| | |
|---|---|
| The machine's owner | Directly. Their own data, which they could have read on the live machine. |
| Anyone else | A granted, unexpired `file_recovery` or `shell` elevation on that machine — which is itself approval-gated (`ElevationService`). |
| Nobody owns it | Elevation, always. There is no owner fast path to fall into. |

Inspection is not charged an elevation level of its own. It is strictly less than a live
files session — read-only, against a frozen copy rather than a running machine — so
requiring more than `file_recovery` would make the safer operation the harder one to
reach, and anyone blocked would restore the snapshot instead, which is a bigger grant.

`ElevationService.request()` never checks machine state, so an elevation can already be
requested against an archived machine. For an offboarded one nobody is the owner, so
`SelfOwnedMachineError` cannot fire and every requester goes through approval.

### The gate runs on every operation, not just at open

`list` and `read` re-ask all six questions `openInspection` asked: does the snapshot exist
in your org, did it capture anything, has it expired, is there a persistent volume, is
inspection enabled here, do you still have standing.

That costs two indexed queries per operation and buys the property that matters: revoking
an elevation stops the reads it was holding open **immediately**, rather than within a
minute when `closeSessionsWithLapsedAuthorization` next runs. The sweep still closes the
session — `relay.ts` dispatches on `sessions.method` so an inspection is re-checked with
its own gate rather than the interactive one — but the window between the two is harmless
rather than merely short.

### Permissions are reported, never enforced

On a live machine, file operations run as an unprivileged OS user and the kernel decides
what they may touch (`fs-helper.ts`, and `docs/access.md` §4b on why that privilege drop is
the security property).

There is no process and no uid here — just bytes and a parser — so **every byte on the
disk is readable to anyone who passes the gate**, including files mode 600. `FsEntry.mode`
is shown because it is useful evidence about the live machine, not because it is applied.

This is why the gate is the whole of the security story rather than one layer of several,
and why it is the part with the tests.

### Reading versus recovering

`read` feeds an editor, so it is capped at 1 MiB and refuses anything with a NUL byte in
the first 8000 — the same two rules a live files session follows, for the same reason: the
content round-trips through a JavaScript string and a binary file would come back subtly
different from what went in.

`download` is the one that answers the use case. The file someone actually needs back is as
likely to be a 40 MiB archive or a database dump as a text note, and if reading inline were
the only route neither could be recovered at all. It returns raw bytes rather than base64
in a JSON body — up to `FS_MAX_TRANSFER_BYTES` (50 MiB), the same ceiling a live session
has.

One consequence: a download failure cannot ride back as `ok: false`, because the body is
the file. Those map to status codes (`404` missing, `409` too large or not a regular file)
carrying the same fixed reason vocabulary, which the console and CLI lift back out so
"too large" still reads as "too large".

### What is readable, and what is not

Only the **persistent disk** — the volume mounted at `/home`. It is `mkfs.ext4` on a raw
device with no partition table (`homeVolumeSection()`), so the superblock is at byte 1024
and there is nothing to parse ahead of it.

The OS disk is not readable in v1. It carries a GPT this build has no parser for, and it
holds the part of a machine that is rebuilt from an image rather than the part that cannot
be recreated. A `full` snapshot captures both; only the `data` disk is opened. A snapshot
with an OS disk and no persistent volume fails with `SnapshotDiskNotReadableError`, not a
misleading empty listing.

Paths are the **machine's**, not the image's. The image root is `/home`, so
`/home/cloudable/notes.txt` is what a person sees for the file they know by that name. A
path off this disk — `/etc/nginx.conf` — is `not_found`, honestly: it is a real path on the
machine, just not on this disk.

Holes and uninitialised extents read as zeroes. The second is a data-leak guard rather than
a nicety: those blocks are allocated and never written, so their contents belong to
whatever used them last.

### The grant is never stored

Reading needs a provider read grant — on Azure, a SAS URL from `snapshots.grantAccess`,
which is a working read capability over someone's home directory. **Invariant 1: no cloud
credential is ever stored.** So `inspection-registry.ts` holds it in memory only, keyed by
session, re-grants lazily after a restart, and revokes on every close path. It is a cache
of an expensive handle, never a record of anything.

Azure authorizes `grantAccess` against `Microsoft.Compute/snapshots/beginGetAccess/action`,
which is **not** the `disks/beginGetAccess` the archive path already has. Both are on
`azurerm_role_definition.machine_operator`; a missing one surfaces as an authorization
failure that the Activity Log does not record.

### Audit

Session-level, using the events that already exist: `access.session_started`,
`access.session_ended`, `access.session_denied`, each carrying `method: "snapshot_files"`.
No new event type — the payload union was widened, the type names did not move, and the
catalogue snapshot test passes unchanged, which is the proof (invariant 11).

Refusals are recorded as well as opens. Nothing is emitted per file read, matching the
live-files precedent in `docs/access.md` §4b.

### Policy

`accessMethodsEnabled.snapshotInspect`, default on, org- or machine-scoped. Separate from
`files` because the two are worth turning off separately: `files` reaches a live machine and
can write to it, this reaches a frozen copy that may have no owner. Neither implies the
other. Turning it off terminates the inspections already open, like the other two methods.

### Not built

- **The OS disk**, as above.
- **Per-path audit.** Deliberate, see above.
- **Local development** needs `FAKE_SNAPSHOT_IMAGE_PATH` pointed at a real ext4 image
  (`apps/control-plane/src/snapshot-fs/__fixtures__/home.img.gz`, gunzipped). Docker
  machines capture no disks, so there is otherwise nothing to read.

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
Azure for the hold period. Billing itself is not in v1 — a rough sizing
estimate at creation is fine, but it must not be called billing. `estimateSnapshotCost()`
(`domain/archive/pricing.ts`) is a **pure, synchronous** function:
`sizeBytes * pricePerGbPerDay * daysRemaining`, using a placeholder Azure managed-disk
snapshot price (`$0.05`/GB-month, LRS pay-as-you-go — not pulled from a live price list,
and not from the subscription's own rates). It returns `0` once a snapshot has already
reached its expiry (no remaining hold period to project).

("no real Azure account exists in this build" stood here, and in two code comments, long
after the azure adapter was running machines in production. Snapshots it created are
sitting in `RG-CLOUDABLE-MANAGED` now. Check a claim like that before relying on it.)

The HTTP response (`GET /api/v1/archive/snapshots/:id/cost-estimate`) always carries a
`disclaimer` field alongside the figure. Nothing in this unit calls this feature
"billing" anywhere — in code, comments, docs, or the API shape.

`sizeBytes` is the real total the provider reported, summed across `capturedDisks`. The
`PLACEHOLDER_SNAPSHOT_SIZE_BYTES` constant this paragraph used to describe is gone.

The price constant is still a placeholder, and its own comment used to call it the
*incremental* snapshot price. It is not: `snapshotOf` never sets `incremental: true`, so
these are full snapshots. Full ones bill on the disk's USED data rather than its
provisioned size, which is why a 30 GiB OS disk costs cents. Switching to incremental
would save nothing here anyway — each disk is copied once and then deleted, so there is
never a previous snapshot in the lineage to be a delta against.

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
| `POST` | `/api/v1/archive/machines/:machineId/snapshots` | Takes a snapshot of a LIVE machine now. Body `{scope?}`, default `shallow`. Never quiesced — the machine keeps running, so the copy is crash-consistent. |
| `POST` | `/api/v1/archive/machines/:machineId/archive` | Body: `{approvalId?}`. `404` if the machine doesn't exist, `409` if it's already archived (archiving is one-way — see "The state machine"). |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/restore` | Body: `RestoreSnapshotRequest`. `404` snapshot or target machine not found, `409` expired, `400` full-mode without acknowledgement, `403` denied/expired approval. |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/legal-hold` | Body: `{reason}`. `400` on an empty reason. |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/legal-hold/clear` | Same shape as above. |
| `GET` | `/api/v1/archive/snapshots/:snapshotId` | Returns `SnapshotView`, including computed `subState` and `restoreUnavailableReason`. |
| `GET` | `/api/v1/archive/snapshots/:snapshotId/cost-estimate` | Returns `SnapshotCostEstimateResponse`. |
| `POST` | `/api/v1/archive/snapshots/:snapshotId/inspections` | Opens a read-only inspection. `403` with a stated reason when the caller neither owns the machine nor holds an elevation; `409` expired/empty/no readable disk. |
| `POST` | `/api/v1/archive/inspections/:sessionId/end` | Ends one. Succeeds on an already-ended session — several paths end one and any may be second. |
| `GET` | `/api/v1/archive/inspections/:sessionId/list?path=` | Directory listing. Re-authorizes first. |
| `GET` | `/api/v1/archive/inspections/:sessionId/read?path=` | File contents, base64, capped at 1 MiB. Re-authorizes first. |
| `GET` | `/api/v1/archive/inspections/:sessionId/download?path=` | Raw bytes, up to 50 MiB. Re-authorizes first. |

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
