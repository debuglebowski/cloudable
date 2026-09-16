import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import {
  FullRestoreNotAcknowledgedError,
  InspectionFileUnreadableError,
  InspectionSessionNotFoundError,
  InvalidLegalHoldReasonError,
  InvalidRestoreApprovalError,
  MachineAlreadyArchivedError,
  MachineNotFoundError,
  RestoreNotApprovedError,
  SnapshotDataMissingError,
  SnapshotDiskNotReadableError,
  SnapshotEmptyError,
  SnapshotExpiredError,
  SnapshotInspectionDeniedError,
  SnapshotNotFoundError,
} from "../../domain/archive";
import { CurrentUserAuthentication } from "../middleware/auth";

// Runtime request/response schemas for /api/v1/archive/*. Field shapes mirror the plain
// TS types in `@cloudable/contracts`'s `domains/archive.ts` — kept in sync by hand (see
// that file's header comment).

const RestoreMode = Schema.Literal("data", "config", "full");
const SnapshotTrigger = Schema.Literal("archive", "upgrade", "manual");
const SnapshotSubState = Schema.Literal("restorable", "expired", "empty", "data_missing");
const ApprovalStatus = Schema.Literal("pending", "approved", "rejected", "expired");

const MachineIdPath = Schema.Struct({ machineId: Schema.String });
const SnapshotIdPath = Schema.Struct({ snapshotId: Schema.String });
const ApprovalIdPath = Schema.Struct({ approvalId: Schema.String });

const ArchiveMachinePayload = Schema.Struct({
  approvalId: Schema.optional(Schema.String),
});

const ArchiveMachineSuccess = Schema.Struct({
  machineId: Schema.String,
  state: Schema.Literal("archived_restorable"),
  snapshotId: Schema.String,
  retentionExpiresAt: Schema.String,
});

// `requestedByPersonId` is gone from the wire — derived from
// `CurrentUserTag.personId` in the handler, not trusted from the client.
const RestoreSnapshotPayload = Schema.Struct({
  mode: RestoreMode,
  targetMachineId: Schema.String,
  reason: Schema.String,
  confirmSecretBindings: Schema.optional(Schema.Boolean),
});

const RestoreSnapshotSuccess = Schema.Struct({
  snapshotId: Schema.String,
  targetMachineId: Schema.String,
  mode: RestoreMode,
  approvalId: Schema.String,
  approvalStatus: ApprovalStatus,
  restored: Schema.Boolean,
});

const LegalHoldPayload = Schema.Struct({ reason: Schema.String });

const LegalHoldSuccess = Schema.Struct({
  snapshotId: Schema.String,
  legalHold: Schema.Boolean,
  legalHoldReason: Schema.NullOr(Schema.String),
});

const SnapshotViewSuccess = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  machineId: Schema.String,
  trigger: SnapshotTrigger,
  region: Schema.NullOr(Schema.String),
  /** Provisioned size of the disks captured. Identical on every machine in a fleet
   * with identical disks, so it is a ceiling, not a measurement. */
  sizeBytes: Schema.NullOr(Schema.Number),
  /** What the snapshot actually stores, as the machine measured its own filesystems
   * just before the copy. Null when never measured — never a zero standing in for it.
   * This is the figure a provider bills. */
  usedBytes: Schema.NullOr(Schema.Number),
  /** "full" captured both disks, "shallow" the persistent volume only. */
  scope: Schema.Literal("full", "shallow"),
  /**
   * How many disks the provider actually copied for this snapshot.
   *
   * Zero means it copied nothing and the row names no cloud object — every snapshot
   * written before snapshots were real is in that state, and `sizeBytes` on those rows
   * is a hardcoded 32 GiB placeholder rather than any disk's size. A consumer must not
   * present that number as a size or a ceiling; it is not a measurement of anything.
   */
  capturedDiskCount: Schema.Number,
  containsData: Schema.Boolean,
  containsConfig: Schema.Boolean,
  legalHold: Schema.Boolean,
  legalHoldReason: Schema.NullOr(Schema.String),
  retentionDays: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  expiredAt: Schema.NullOr(Schema.String),
  /** When the integrity sweep first found a recorded disk missing at the provider.
   * Null normally. Set means the data went away while retention was still open. */
  dataMissingAt: Schema.NullOr(Schema.String),
  subState: SnapshotSubState,
  restoreUnavailableReason: Schema.NullOr(Schema.String),
});

const CostEstimateSuccess = Schema.Struct({
  snapshotId: Schema.String,
  estimatedCostUsd: Schema.Number,
  currency: Schema.Literal("USD"),
  disclaimer: Schema.String,
});

const ListSnapshotsUrlParams = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

const ListSnapshotsResponse = Schema.Struct({
  items: Schema.Array(SnapshotViewSuccess),
  pageInfo: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
});

const SessionIdPath = Schema.Struct({ sessionId: Schema.String });

/** `path` is a URL param rather than a body, because these are GETs — a directory
 * listing is a read and should behave like one (cacheable, re-runnable, safe). */
const InspectionPathParams = Schema.Struct({ path: Schema.String });

/**
 * Raw bytes, not a base64 field on a JSON body.
 *
 * `read` is capped at 1 MiB and refuses anything with a NUL byte, because it feeds an
 * editor. Recovery does not stop at text under a megabyte — the file someone actually
 * needs back is as likely to be a 40 MiB archive — so download is the operation that makes
 * this feature answer its own use case, and base64 through JSON would inflate it by a
 * third for nothing.
 */
const FileBytes = Schema.Uint8ArrayFromSelf.pipe(
  HttpApiSchema.withEncoding({ kind: "Uint8Array", contentType: "application/octet-stream" }),
);

const OpenInspectionSuccess = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: Schema.String,
  machineId: Schema.String,
  /** Where a browser should open: the machine's home directory. */
  rootPath: Schema.String,
  expiresAt: Schema.String,
});

const FsEntrySchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal("file", "directory", "symlink", "other"),
  sizeBytes: Schema.Number,
  modifiedAt: Schema.String,
  mode: Schema.String,
  symlinkTarget: Schema.NullOr(Schema.String),
});

/**
 * Mirrors `FsResult` from `@cloudable/contracts`, minus the operations a snapshot does
 * not have. The console's file browser already speaks this, which is why inspection
 * reuses the vocabulary instead of inventing a parallel one.
 *
 * A filesystem-level failure is a 200 carrying `ok: false`, not an HTTP error — the
 * same choice the live path makes. "That file is binary" is an answer the browser
 * renders, not a transport failure.
 */
const FsResultSchema = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(true),
    op: Schema.Literal("list"),
    path: Schema.String,
    parent: Schema.NullOr(Schema.String),
    entries: Schema.Array(FsEntrySchema),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    op: Schema.Literal("read"),
    path: Schema.String,
    contentBase64: Schema.String,
    modifiedAt: Schema.String,
    sizeBytes: Schema.Number,
  }),
);

export const ArchiveGroup = HttpApiGroup.make("archive")
  .add(
    HttpApiEndpoint.post("archiveMachine", "/api/v1/archive/machines/:machineId/archive")
      .setPath(MachineIdPath)
      .setPayload(ArchiveMachinePayload)
      .addSuccess(ArchiveMachineSuccess)
      .addError(MachineNotFoundError, { status: 404 })
      .addError(MachineAlreadyArchivedError, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.post("restoreSnapshot", "/api/v1/archive/snapshots/:snapshotId/restore")
      .setPath(SnapshotIdPath)
      .setPayload(RestoreSnapshotPayload)
      .addSuccess(RestoreSnapshotSuccess)
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(SnapshotExpiredError, { status: 409 })
      .addError(SnapshotEmptyError, { status: 409 })
      .addError(SnapshotDataMissingError, { status: 409 })
      .addError(FullRestoreNotAcknowledgedError, { status: 400 })
      .addError(RestoreNotApprovedError, { status: 403 }),
  )
  .add(
    // Resumes a `"pending"` restore (single/dual approval mode) once its
    // approval has since been decided — same "sync" shape elevations and
    // offboarding already use (see `domain/archive/restore.ts`'s
    // `resumeRestore` doc comment). A foreign or non-restore approval id
    // resolves to `InvalidRestoreApprovalError`, the same non-leaking shape
    // used everywhere else.
    HttpApiEndpoint.post("resumeRestore", "/api/v1/archive/restores/:approvalId/sync")
      .setPath(ApprovalIdPath)
      .addSuccess(RestoreSnapshotSuccess)
      .addError(InvalidRestoreApprovalError, { status: 404 })
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(SnapshotExpiredError, { status: 409 })
      .addError(SnapshotEmptyError, { status: 409 })
      .addError(SnapshotDataMissingError, { status: 409 })
      .addError(RestoreNotApprovedError, { status: 403 }),
  )
  .add(
    HttpApiEndpoint.post("setLegalHold", "/api/v1/archive/snapshots/:snapshotId/legal-hold")
      .setPath(SnapshotIdPath)
      .setPayload(LegalHoldPayload)
      .addSuccess(LegalHoldSuccess)
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(InvalidLegalHoldReasonError, { status: 400 }),
  )
  .add(
    HttpApiEndpoint.post("clearLegalHold", "/api/v1/archive/snapshots/:snapshotId/legal-hold/clear")
      .setPath(SnapshotIdPath)
      .setPayload(LegalHoldPayload)
      .addSuccess(LegalHoldSuccess)
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(InvalidLegalHoldReasonError, { status: 400 }),
  )
  .add(
    HttpApiEndpoint.get("listSnapshots", "/api/v1/archive/snapshots")
      .setUrlParams(ListSnapshotsUrlParams)
      .addSuccess(ListSnapshotsResponse),
  )
  .add(
    HttpApiEndpoint.get("getSnapshot", "/api/v1/archive/snapshots/:snapshotId")
      .setPath(SnapshotIdPath)
      .addSuccess(SnapshotViewSuccess)
      .addError(SnapshotNotFoundError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get(
      "getSnapshotCostEstimate",
      "/api/v1/archive/snapshots/:snapshotId/cost-estimate",
    )
      .setPath(SnapshotIdPath)
      .addSuccess(CostEstimateSuccess)
      .addError(SnapshotNotFoundError, { status: 404 }),
  )
  .add(
    // Opening is a POST because it creates a session row and writes an event. The reads
    // that follow are GETs against that session.
    HttpApiEndpoint.post("openInspection", "/api/v1/archive/snapshots/:snapshotId/inspections")
      .setPath(SnapshotIdPath)
      .addSuccess(OpenInspectionSuccess)
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(SnapshotExpiredError, { status: 409 })
      .addError(SnapshotEmptyError, { status: 409 })
      .addError(SnapshotDiskNotReadableError, { status: 409 })
      // 403 with a stated reason, never a 404 that hides the snapshot: the person is
      // allowed to know it exists and what to do about it (request an elevation).
      .addError(SnapshotInspectionDeniedError, { status: 403 }),
  )
  .add(
    HttpApiEndpoint.post("closeInspection", "/api/v1/archive/inspections/:sessionId/end")
      .setPath(SessionIdPath)
      .addSuccess(Schema.Struct({ ok: Schema.Literal(true) })),
  )
  .add(
    HttpApiEndpoint.get("inspectionList", "/api/v1/archive/inspections/:sessionId/list")
      .setPath(SessionIdPath)
      .setUrlParams(InspectionPathParams)
      .addSuccess(FsResultSchema)
      .addError(InspectionSessionNotFoundError, { status: 404 })
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(SnapshotExpiredError, { status: 409 })
      .addError(SnapshotEmptyError, { status: 409 })
      .addError(SnapshotDiskNotReadableError, { status: 409 })
      .addError(SnapshotInspectionDeniedError, { status: 403 }),
  )
  .add(
    HttpApiEndpoint.get("inspectionRead", "/api/v1/archive/inspections/:sessionId/read")
      .setPath(SessionIdPath)
      .setUrlParams(InspectionPathParams)
      .addSuccess(FsResultSchema)
      .addError(InspectionSessionNotFoundError, { status: 404 })
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(SnapshotExpiredError, { status: 409 })
      .addError(SnapshotEmptyError, { status: 409 })
      .addError(SnapshotDiskNotReadableError, { status: 409 })
      .addError(SnapshotInspectionDeniedError, { status: 403 }),
  )
  .add(
    // Unlike `list`/`read`, a filesystem failure here cannot ride back as `ok: false` in
    // the body — the body is the file. So they map to status codes: 404 for a missing
    // path, 409 for one too large to transfer or not a regular file.
    HttpApiEndpoint.get("inspectionDownload", "/api/v1/archive/inspections/:sessionId/download")
      .setPath(SessionIdPath)
      .setUrlParams(InspectionPathParams)
      .addSuccess(FileBytes)
      .addError(InspectionSessionNotFoundError, { status: 404 })
      .addError(SnapshotNotFoundError, { status: 404 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(SnapshotExpiredError, { status: 409 })
      .addError(SnapshotEmptyError, { status: 409 })
      .addError(SnapshotDiskNotReadableError, { status: 409 })
      .addError(SnapshotInspectionDeniedError, { status: 403 })
      .addError(InspectionFileUnreadableError, { status: 409 }),
  )
  .middleware(CurrentUserAuthentication);
