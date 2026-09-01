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
 * (spec §14 "live -> archived") and is never repeated for the same machine. */
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
 * shown, never just hidden (spec §14 "Archived, expired"). */
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
