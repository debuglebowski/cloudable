import { Effect } from "effect";
import { ulid } from "ulid";
import type { Db } from "../../db/layer";
import { ApprovalService } from "../../services/ApprovalService";
import { EventBus, type EventBusError } from "../../services/EventBus";
import { type RestoreMode, resolveRestoreApprovalFloor } from "./approval-escalation";
import {
  ApprovalRequestFailedError,
  ArchiveDbError,
  FullRestoreNotAcknowledgedError,
  InvalidRestoreApprovalError,
  RestoreNotApprovedError,
  SnapshotExpiredError,
} from "./errors";
import { makeEnvelope } from "./events";
import {
  fetchMachine,
  fetchSnapshot,
  findRestoreRequest,
  markRestoreRequestCompleted,
  saveRestoreRequest,
} from "./queries";
import { getSnapshotSubState, restoreUnavailableReason } from "./sub-state";

export type { RestoreMode } from "./approval-escalation";

export interface RestoreSnapshotInput {
  snapshotId: string;
  mode: RestoreMode;
  requestedByPersonId: string;
  targetMachineId: string;
  reason: string;
  /**
   * Required — and must be `true` — when `mode` is `"full"`: an explicit, separate
   * acknowledgement that this restore reattaches secret bindings. Never defaulted and
   * never inferred from the other fields, so a data/config restore can never silently
   * escalate into reattaching secrets. Ignored for `mode: "data"` / `"config"`.
   */
  confirmSecretBindings?: boolean | undefined;
}

export interface RestoreSnapshotResult {
  snapshotId: string;
  targetMachineId: string;
  mode: RestoreMode;
  approvalId: string;
  approvalStatus: "pending" | "approved" | "rejected" | "expired";
  /** `true` only once the restore has actually happened. A `"pending"` approval
   * (single/dual mode, awaiting a human decision) returns `false` here — completing
   * the restore once that decision lands is out of this unit's scope; see the note
   * below. */
  restored: boolean;
}

const publishOrDie = <A>(
  effect: Effect.Effect<A, EventBusError>,
): Effect.Effect<A, ArchiveDbError> =>
  effect.pipe(
    Effect.mapError(
      (cause) => new ArchiveDbError({ reason: `event_publish_failed: ${cause.reason}` }),
    ),
  );

/**
 * Restores a snapshot under mode-escalating approval. Signature is exact
 * and load-bearing — callers rely on it directly.
 *
 * Validates both that the snapshot exists and that `targetMachineId` refers to a real
 * machine before requesting approval — an approval should never be requested (and,
 * once `ApprovalService` is real, granted) for a restore whose target doesn't exist.
 *
 * Approval gate: always calls `ApprovalService.request()` with
 * `actionType: "snapshot_restore"` and only proceeds — i.e. performs the restore and
 * writes `snapshot.restored` — once its `status` is `"approved"`. See
 * `approval-escalation.ts` for exactly how the three restore modes escalate the
 * required approval bar on top of that single, generic action type.
 *
 * What "performing the restore" means here: this unit validates eligibility, enforces
 * the approval gate, and writes the permanent audit record that the restore happened.
 * It does not itself reach into a cloud API to reattach a volume or reapply
 * configuration — `ProvisioningService` (see `services/ProvisioningService.ts`) has no
 * restore-specific operation in this build, and inventing one is out of this unit's file
 * scope. The mechanical reattachment is desired-state work for the reconciliation loop
 * once `targetMachineId`'s desired state reflects the restored snapshot. Likewise, a
 * `"pending"` approval status (single/dual mode) is a legitimate, non-error outcome —
 * completing the restore once a human later decides the approval is a follow-up concern
 * for whichever unit wires `ApprovalService.decide()` to a callback; it is not built
 * here.
 *
 * The escalation floor from `resolveRestoreApprovalFloor` is passed to
 * `ApprovalService.request()` as `requiredModeFloor` — enforced there structurally
 * (clamped up, never satisfiable by a weaker org-configured mode), not just recorded in
 * the approval's `reason` text. See `approval-escalation.ts`'s doc comment for exactly
 * what each restore mode's floor is and why.
 */
export const restoreSnapshot = (input: RestoreSnapshotInput) =>
  Effect.gen(function* () {
    const eventBus = yield* EventBus;
    const approvalService = yield* ApprovalService;

    const snapshot = yield* fetchSnapshot(input.snapshotId);
    // Validate the restore target exists, and belongs to the SAME org as the snapshot,
    // up front — otherwise an approval could be requested (and, once ApprovalService is
    // real, granted) for a typo'd, nonexistent, or cross-tenant machine, with
    // `snapshot.restored` written against a machine that was never real or never should
    // have been reachable from this snapshot at all.
    yield* fetchMachine(input.targetMachineId, snapshot.orgId);

    if (getSnapshotSubState(snapshot) === "expired") {
      const expiredAt = snapshot.expiredAt as Date;
      return yield* Effect.fail(
        new SnapshotExpiredError({
          snapshotId: snapshot.id,
          expiredAt: expiredAt.toISOString(),
          reason: restoreUnavailableReason(snapshot) ?? "Snapshot expired.",
        }),
      );
    }

    if (input.mode === "full" && input.confirmSecretBindings !== true) {
      return yield* Effect.fail(new FullRestoreNotAcknowledgedError({ snapshotId: snapshot.id }));
    }

    const approvalFloor = resolveRestoreApprovalFloor(input.mode);

    const correlationId = ulid();
    const annotatedReason = `[snapshot restore | mode=${input.mode} | approval-floor=${approvalFloor}] ${input.reason}`;

    const approvalResult = yield* approvalService
      .request({
        orgId: snapshot.orgId,
        actionType: "snapshot_restore",
        requestedByPersonId: input.requestedByPersonId,
        targetMachineId: input.targetMachineId,
        reason: annotatedReason,
        requiredModeFloor: approvalFloor,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ApprovalRequestFailedError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

    if (approvalResult.status === "rejected" || approvalResult.status === "expired") {
      return yield* Effect.fail(
        new RestoreNotApprovedError({
          snapshotId: snapshot.id,
          approvalId: approvalResult.id,
          status: approvalResult.status,
        }),
      );
    }

    if (approvalResult.status === "pending") {
      // Persisted so `resumeRestore` can pick this up once the approval is
      // later decided — the approval row alone can't carry `snapshotId`/
      // `mode`/`confirmSecretBindings` (see `restoreRequests`'s own doc
      // comment in `packages/schema`).
      yield* saveRestoreRequest({
        approvalId: approvalResult.id,
        snapshotId: snapshot.id,
        targetMachineId: input.targetMachineId,
        mode: input.mode,
        confirmSecretBindings: input.confirmSecretBindings ?? false,
        requestedByPersonId: input.requestedByPersonId,
        reason: input.reason,
      }).pipe(
        Effect.mapError(
          (cause) => new ArchiveDbError({ reason: `save_restore_request_failed: ${cause.reason}` }),
        ),
      );

      return {
        snapshotId: snapshot.id,
        targetMachineId: input.targetMachineId,
        mode: input.mode,
        approvalId: approvalResult.id,
        approvalStatus: approvalResult.status,
        restored: false,
      } satisfies RestoreSnapshotResult;
    }

    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({
            orgId: snapshot.orgId,
            machineId: input.targetMachineId,
            correlationId,
            actorType: "person",
            actorId: input.requestedByPersonId,
          }),
          type: "snapshot.restored",
          payload: {
            mode: input.mode,
            targetMachineId: input.targetMachineId,
            approvalId: approvalResult.id,
          },
        },
      ]),
    );

    return {
      snapshotId: snapshot.id,
      targetMachineId: input.targetMachineId,
      mode: input.mode,
      approvalId: approvalResult.id,
      approvalStatus: "approved",
      restored: true,
    } satisfies RestoreSnapshotResult;
  });

/**
 * Picks up a restore left `"pending"` by `restoreSnapshot` once its approval
 * has since been decided — same "sync" shape `ElevationService.syncApproval`
 * already uses for the identical problem (an approval decided later, out of
 * band from the original request call). A no-op while still pending, and
 * idempotent once completed (a repeated call finds `restoreRequests.completedAt`
 * already set and returns the prior result rather than re-publishing
 * `snapshot.restored`).
 *
 * `approvalId` alone can't identify what to resume — see `restoreRequests`'s
 * own doc comment — so a missing `restore_requests` row collapses to the
 * same `InvalidRestoreApprovalError` as a foreign/nonexistent approval id:
 * never leak which case it is.
 */
export const resumeRestore = (
  approvalId: string,
  orgId: string,
): Effect.Effect<
  RestoreSnapshotResult,
  InvalidRestoreApprovalError | RestoreNotApprovedError | ArchiveDbError,
  Db | EventBus | ApprovalService
> =>
  Effect.gen(function* () {
    const approvalService = yield* ApprovalService;

    const restoreRequest = yield* findRestoreRequest(approvalId).pipe(
      Effect.mapError(
        (cause) => new ArchiveDbError({ reason: `find_restore_request_failed: ${cause.reason}` }),
      ),
    );
    if (!restoreRequest) {
      return yield* Effect.fail(new InvalidRestoreApprovalError({ approvalId }));
    }

    if (restoreRequest.completedAt) {
      return {
        snapshotId: restoreRequest.snapshotId,
        targetMachineId: restoreRequest.targetMachineId,
        mode: restoreRequest.mode,
        approvalId,
        approvalStatus: "approved",
        restored: true,
      } satisfies RestoreSnapshotResult;
    }

    // `orgId` here is the authenticated caller's own org — a restore request
    // for another org's approval must fail the same way a nonexistent one
    // does, never distinguishably.
    const approvalResult = yield* approvalService
      .status(approvalId, orgId)
      .pipe(Effect.catchAll(() => Effect.fail(new InvalidRestoreApprovalError({ approvalId }))));

    if (approvalResult.status === "pending") {
      return {
        snapshotId: restoreRequest.snapshotId,
        targetMachineId: restoreRequest.targetMachineId,
        mode: restoreRequest.mode,
        approvalId,
        approvalStatus: "pending",
        restored: false,
      } satisfies RestoreSnapshotResult;
    }

    if (approvalResult.status === "rejected" || approvalResult.status === "expired") {
      return yield* Effect.fail(
        new RestoreNotApprovedError({
          snapshotId: restoreRequest.snapshotId,
          approvalId,
          status: approvalResult.status,
        }),
      );
    }

    const eventBus = yield* EventBus;
    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({
            orgId,
            machineId: restoreRequest.targetMachineId,
            correlationId: ulid(),
            actorType: "person",
            actorId: restoreRequest.requestedByPersonId,
          }),
          type: "snapshot.restored",
          payload: {
            mode: restoreRequest.mode,
            targetMachineId: restoreRequest.targetMachineId,
            approvalId,
          },
        },
      ]),
    );
    yield* markRestoreRequestCompleted(approvalId).pipe(
      Effect.mapError(
        (cause) =>
          new ArchiveDbError({ reason: `mark_restore_request_completed_failed: ${cause.reason}` }),
      ),
    );

    return {
      snapshotId: restoreRequest.snapshotId,
      targetMachineId: restoreRequest.targetMachineId,
      mode: restoreRequest.mode,
      approvalId,
      approvalStatus: "approved",
      restored: true,
    } satisfies RestoreSnapshotResult;
  });
