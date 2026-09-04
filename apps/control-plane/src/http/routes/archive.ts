import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  FullRestoreNotAcknowledgedError,
  InvalidLegalHoldReasonError,
  InvalidRestoreApprovalError,
  MachineAlreadyArchivedError,
  MachineNotFoundError,
  RestoreNotApprovedError,
  SnapshotExpiredError,
  SnapshotNotFoundError,
} from "../../domain/archive";
import { CurrentUserAuthentication } from "../middleware/auth";

// Runtime request/response schemas for /api/v1/archive/*. Field shapes mirror the plain
// TS types in `@cloudable/contracts`'s `domains/archive.ts` — kept in sync by hand (see
// that file's header comment).

const RestoreMode = Schema.Literal("data", "config", "full");
const SnapshotTrigger = Schema.Literal("archive", "upgrade", "manual");
const SnapshotSubState = Schema.Literal("restorable", "expired");
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
  sizeBytes: Schema.NullOr(Schema.Number),
  containsData: Schema.Boolean,
  containsConfig: Schema.Boolean,
  legalHold: Schema.Boolean,
  legalHoldReason: Schema.NullOr(Schema.String),
  retentionDays: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  expiredAt: Schema.NullOr(Schema.String),
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
  .middleware(CurrentUserAuthentication);
