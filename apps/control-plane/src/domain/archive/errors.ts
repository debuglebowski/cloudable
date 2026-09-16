import { Schema } from "effect";

/**
 * Domain errors for the archive lifecycle. Defined as `Schema.TaggedError` (not plain
 * `Data.TaggedError`) so the same class is usable both as a typed Effect failure in
 * domain code AND directly in `HttpApiEndpoint.addError()` at the HTTP boundary —
 * see `http/routes/archive.ts`.
 *
 * Errors that represent our own infrastructure breaking (DB, event publication, the
 * generic `ApprovalService` failing) are intentionally listed here too, but the HTTP
 * handlers convert them to defects (`Effect.die`) rather than declaring them via
 * `.addError()` — they are not meaningful, actionable outcomes for an API caller, only
 * for the domain logic and its tests.
 */

export class MachineNotFoundError extends Schema.TaggedError<MachineNotFoundError>()(
  "MachineNotFoundError",
  {
    machineId: Schema.String,
  },
) {}

/** The machine is already in an archived state — archiving is a one-way transition
 * ("live -> archived") and is never repeated for the same machine. */
export class MachineAlreadyArchivedError extends Schema.TaggedError<MachineAlreadyArchivedError>()(
  "MachineAlreadyArchivedError",
  { machineId: Schema.String, state: Schema.String },
) {}

export class SnapshotNotFoundError extends Schema.TaggedError<SnapshotNotFoundError>()(
  "SnapshotNotFoundError",
  {
    snapshotId: Schema.String,
  },
) {}

/** Restore was attempted against a snapshot whose retention window has elapsed and
 * whose volume data was hard-deleted. Restore must be greyed out with this reason
 * shown, never just hidden ("Archived, expired"). */
/**
 * The snapshot names no disks at the provider, so there is nothing to restore FROM.
 *
 * Distinct from `SnapshotExpiredError`: that one means the data existed and its
 * retention elapsed. This means it never existed. Every snapshot written before
 * `createSnapshot` called a provider is in this state — a row, a retention clock and a
 * Restore button standing over nothing. Six of them are in production.
 *
 * Same 409 as expiry, and the same rule: greyed out WITH the reason shown, never
 * hidden. A restore that silently succeeds against no data is how this went unnoticed.
 */
export class SnapshotEmptyError extends Schema.TaggedError<SnapshotEmptyError>()(
  "SnapshotEmptyError",
  {
    snapshotId: Schema.String,
    reason: Schema.String,
  },
) {}

export class SnapshotExpiredError extends Schema.TaggedError<SnapshotExpiredError>()(
  "SnapshotExpiredError",
  {
    snapshotId: Schema.String,
    expiredAt: Schema.String,
    reason: Schema.String,
  },
) {}

/** `mode: "full"` restores secret bindings and must never be a byproduct of a
 * data/config restore — the caller must pass an explicit, separate acknowledgement. */
export class FullRestoreNotAcknowledgedError extends Schema.TaggedError<FullRestoreNotAcknowledgedError>()(
  "FullRestoreNotAcknowledgedError",
  { snapshotId: Schema.String },
) {}

/** The approval gating this restore was denied or expired before a decision. */
export class RestoreNotApprovedError extends Schema.TaggedError<RestoreNotApprovedError>()(
  "RestoreNotApprovedError",
  {
    snapshotId: Schema.String,
    approvalId: Schema.String,
    status: Schema.Literal("rejected", "expired"),
  },
) {}

export class InvalidLegalHoldReasonError extends Schema.TaggedError<InvalidLegalHoldReasonError>()(
  "InvalidLegalHoldReasonError",
  { message: Schema.String },
) {}

/** `resumeRestore`'s target approval isn't a `snapshot_restore` approval, doesn't belong
 * to the caller's org, or has no persisted `restore_requests` row (should never happen
 * for a genuine `snapshot_restore` approval, but a foreign/malformed id must not leak
 * which case it is — same non-leaking "not found" shape as everywhere else). */
export class InvalidRestoreApprovalError extends Schema.TaggedError<InvalidRestoreApprovalError>()(
  "InvalidRestoreApprovalError",
  { approvalId: Schema.String },
) {}

/** `ApprovalService.request()` itself failed (it is still a unit-5 stub — see
 * `services/ApprovalService.ts`). Never surfaced to callers as a specific wire error;
 * the HTTP layer treats it as an internal failure. */
export class ApprovalRequestFailedError extends Schema.TaggedError<ApprovalRequestFailedError>()(
  "ApprovalRequestFailedError",
  { reason: Schema.String },
) {}

/** Our own DB read/write or event publication failed unexpectedly. Never surfaced to
 * callers with detail — the HTTP layer treats it as an internal failure (500). */
export class ArchiveDbError extends Schema.TaggedError<ArchiveDbError>()("ArchiveDbError", {
  reason: Schema.String,
}) {}

/**
 * The caller may not inspect this snapshot: they do not own the machine and hold no
 * granted elevation on it.
 *
 * Carries `reason` because the console must say WHY rather than hiding the action, the
 * same rule `restoreUnavailableReason` follows. "You need approval to look at this" is
 * actionable; a missing button is not.
 */
export class SnapshotInspectionDeniedError extends Schema.TaggedError<SnapshotInspectionDeniedError>()(
  "SnapshotInspectionDeniedError",
  { snapshotId: Schema.String, reason: Schema.String },
) {}

/** No inspection session with this id belongs to this caller, or it has already ended.
 *
 * One error for all three of "no such session", "someone else's session" and "ended",
 * deliberately — distinguishing them tells an unauthorized caller which session ids are
 * real, the same reasoning `fetchSnapshot` follows for cross-org reads. */
export class InspectionSessionNotFoundError extends Schema.TaggedError<InspectionSessionNotFoundError>()(
  "InspectionSessionNotFoundError",
  { sessionId: Schema.String },
) {}

/** The snapshot captured disks, but none of them is the persistent one this can read.
 *
 * Distinct from `SnapshotEmptyError` (captured nothing at all): here there IS data,
 * just not data v1 reads. A `shallow` snapshot always has it; a `full` one has it plus
 * the OS disk, which needs a partition-table parser this build does not have. */
export class SnapshotDiskNotReadableError extends Schema.TaggedError<SnapshotDiskNotReadableError>()(
  "SnapshotDiskNotReadableError",
  { snapshotId: Schema.String, reason: Schema.String },
) {}

/** A download could not be served: the path is missing, is a directory, or is larger than
 * `FS_MAX_TRANSFER_BYTES`. Carries the same fixed reason vocabulary `FsResult` uses, since
 * a raw-bytes response has nowhere to put an `ok: false` body. */
export class InspectionFileUnreadableError extends Schema.TaggedError<InspectionFileUnreadableError>()(
  "InspectionFileUnreadableError",
  { path: Schema.String, reason: Schema.String },
) {}
