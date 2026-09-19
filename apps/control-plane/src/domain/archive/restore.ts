import type { CapturedDisk } from "@cloudable/schema";
import { Effect } from "effect";
import { ulid } from "ulid";
import type { Db } from "../../db/layer";
import { ApprovalService } from "../../services/ApprovalService";
import { EventBus, type EventBusError } from "../../services/EventBus";
import type { ProvisioningServiceTag } from "../../services/ProvisioningService";
import type { MachineService } from "../machine/MachineService";
import {
  type RestoreMode,
  type RestoreTargetKind,
  resolveRestoreApprovalFloor,
} from "./approval-escalation";
import {
  ApprovalRequestFailedError,
  ArchiveDbError,
  FullRestoreNotAcknowledgedError,
  InvalidRestoreApprovalError,
  RestoreFailedError,
  RestoreModeUnsupportedError,
  RestoreNotApprovedError,
  RestoreSourceIncompatibleError,
  RestoreTargetNotConfirmedError,
  SnapshotDataMissingError,
  SnapshotEmptyError,
  SnapshotExpiredError,
} from "./errors";
import { makeEnvelope } from "./events";
import {
  dataDiskOf,
  performRestoreIntoNewMachine,
  performRestoreOntoMachine,
} from "./perform-restore";
import type { MachineRow } from "./queries";
import {
  fetchMachine,
  fetchSnapshot,
  findRestoreRequest,
  markRestoreRequestCompleted,
  saveRestoreRequest,
} from "./queries";
import type { SnapshotRow } from "./snapshot";
import { capturedNothing, getSnapshotSubState, restoreUnavailableReason } from "./sub-state";

export type { RestoreMode } from "./approval-escalation";

/**
 * What a restore lands on.
 *
 * A union rather than optional fields so "both" and "neither" cannot be expressed. The two
 * kinds are genuinely different operations: one provisions a machine and touches nothing
 * existing, the other destroys a machine's current data disk and replaces it.
 */
export type RestoreTarget =
  | {
      kind: "new_machine";
      /**
       * Never inferred from the snapshot's original machine. A common restore is
       * recovering an offboarded person's data, and that former owner is precisely who
       * should not be handed the new machine — invariant 3, exactly one owner, always a
       * person.
       */
      ownerPersonId: string;
      name?: string;
    }
  | {
      kind: "existing_machine";
      machineId: string;
      /** Required when the target still has a data disk to lose, i.e. any state but
       * archived. Explicit and separate, like `confirmSecretBindings`, so that reusing a
       * request shape aimed at an archived machine can never silently destroy a running
       * one's /home. */
      confirmDestroysData?: boolean;
    };

export interface RestoreSnapshotInput {
  snapshotId: string;
  mode: RestoreMode;
  requestedByPersonId: string;
  target: RestoreTarget;
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
  /** `null` only while a new-machine restore is still pending approval: the machine is
   * deliberately not created until someone has approved creating it. */
  targetMachineId: string | null;
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
const ARCHIVED_STATES = new Set(["archived_restorable", "archived_expired"]);

/** `config` and `full` have nothing behind them and must say so rather than consuming an
 * approval and writing a restore that did not happen. See `RestoreModeUnsupportedError`. */
const requireSupportedMode = (snapshotId: string, mode: RestoreMode) =>
  mode === "data"
    ? Effect.void
    : Effect.fail(
        new RestoreModeUnsupportedError({
          snapshotId,
          mode,
          reason:
            mode === "config"
              ? "A snapshot records no configuration to restore — nothing captures it. Only a data restore is available."
              : "A full restore reattaches secret bindings, which this build never creates. Only a data restore is available.",
        }),
      );

/** The snapshot must actually contain a data disk. Reachable for real: `snapshot()`
 * captures each disk only if it exists, so a machine with no data disk yields an OS-only
 * snapshot whose `capturedDisks` is non-empty — which `capturedNothing` does not catch. */
const requireDataDisk = (snapshot: SnapshotRow) =>
  Effect.gen(function* () {
    const disk = dataDiskOf(snapshot);
    if (!disk) {
      return yield* Effect.fail(
        new RestoreSourceIncompatibleError({
          snapshotId: snapshot.id,
          reason: "This snapshot captured no data disk, so there is nothing to restore from.",
        }),
      );
    }
    return disk;
  });

/**
 * Everything about the target that must be true before an approval is requested.
 *
 * The region check is the one that matters most for ordering: a managed disk cannot be
 * created from a snapshot in another region, and ARM would only say so after the machine
 * had already been torn down.
 */
const requireRestorableTarget = (
  snapshot: SnapshotRow,
  sourceMachine: MachineRow,
  targetMachine: MachineRow | null,
  target: RestoreTarget,
) =>
  Effect.gen(function* () {
    const incompatible = (reason: string) =>
      Effect.fail(new RestoreSourceIncompatibleError({ snapshotId: snapshot.id, reason }));

    const machine = targetMachine ?? sourceMachine;
    if (machine.provider !== "azure") {
      return yield* incompatible(
        `Only azure machines capture disks; ${machine.provider} has nothing to restore.`,
      );
    }
    if (snapshot.region !== null && machine.region !== null && snapshot.region !== machine.region) {
      return yield* incompatible(
        `The snapshot is in ${snapshot.region} and the machine is in ${machine.region}. A disk cannot be restored across regions.`,
      );
    }

    if (targetMachine === null || target.kind !== "existing_machine") return;

    if (targetMachine.state === "archived_expired") {
      return yield* incompatible(
        "This machine's archive has expired; its data was destroyed and it cannot be restored onto.",
      );
    }
    if (targetMachine.state === "provisioning") {
      return yield* incompatible(
        "This machine is still being provisioned. Wait for it to settle before restoring onto it.",
      );
    }
    // An archived machine has no disks left to lose, so it needs no acknowledgement. Any
    // other state does.
    if (!ARCHIVED_STATES.has(targetMachine.state) && target.confirmDestroysData !== true) {
      return yield* Effect.fail(
        new RestoreTargetNotConfirmedError({
          snapshotId: snapshot.id,
          targetMachineId: targetMachine.id,
          state: targetMachine.state,
        }),
      );
    }
  });

export const restoreSnapshot = (input: RestoreSnapshotInput) =>
  Effect.gen(function* () {
    const eventBus = yield* EventBus;
    const approvalService = yield* ApprovalService;

    const snapshot = yield* fetchSnapshot(input.snapshotId);

    // FIRST, before anything else and long before an approval is requested: a mode with no
    // implementation behind it must not consume a sign-off and then refuse itself. `config`
    // and `full` used to pass the gate and write `snapshot.restored` over a machine nobody
    // touched.
    yield* requireSupportedMode(snapshot.id, input.mode);
    // The snapshot's own machine: the shape a new machine is rebuilt from, and the source
    // of the provider/region a restore has to stay inside. Still present even when
    // archived — invariant 6 archives, never deletes.
    const sourceMachine = yield* fetchMachine(snapshot.machineId, snapshot.orgId);

    // Validate the target up front, same reasoning as before: an approval must never be
    // requested for a typo'd, nonexistent, or cross-tenant machine, with
    // `snapshot.restored` written against something that was never real.
    const targetMachine =
      input.target.kind === "existing_machine"
        ? yield* fetchMachine(input.target.machineId, snapshot.orgId)
        : null;

    // Before the expiry check and before any approval is requested: asking two people
    // to sign off on restoring nothing is worse than refusing outright.
    if (capturedNothing(snapshot)) {
      return yield* Effect.fail(
        new SnapshotEmptyError({
          snapshotId: snapshot.id,
          reason: restoreUnavailableReason(snapshot) ?? "Snapshot captured no disks.",
        }),
      );
    }

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

    // Checked here rather than left to the reconcile loop to discover: the whole point
    // of the integrity sweep is that a restore must not consume an approval — up to dual
    // sign-off — to put back data that is not there. Same 409 and the same stated reason
    // an expired or empty snapshot gets.
    if (getSnapshotSubState(snapshot) === "data_missing") {
      return yield* Effect.fail(
        new SnapshotDataMissingError({
          snapshotId: snapshot.id,
          reason:
            restoreUnavailableReason(snapshot) ??
            "The disks this snapshot records no longer exist at the provider.",
        }),
      );
    }

    if (input.mode === "full" && input.confirmSecretBindings !== true) {
      return yield* Effect.fail(new FullRestoreNotAcknowledgedError({ snapshotId: snapshot.id }));
    }

    // Everything below is still cheap and non-destructive, and all of it happens before an
    // approval is requested.
    const dataDisk = yield* requireDataDisk(snapshot);
    yield* requireRestorableTarget(snapshot, sourceMachine, targetMachine, input.target);

    const targetKind: RestoreTargetKind =
      targetMachine === null
        ? "new_machine"
        : ARCHIVED_STATES.has(targetMachine.state)
          ? "archived_machine"
          : "live_machine";

    const approvalFloor = resolveRestoreApprovalFloor(input.mode, targetKind);

    const correlationId = ulid();
    const annotatedReason = `[snapshot restore | mode=${input.mode} | approval-floor=${approvalFloor}] ${input.reason}`;

    const approvalResult = yield* approvalService
      .request({
        orgId: snapshot.orgId,
        actionType: "snapshot_restore",
        requestedByPersonId: input.requestedByPersonId,
        targetMachineId: targetMachine?.id ?? null,
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
        targetKind: input.target.kind,
        // Null for a new machine: it is deliberately not created until the restore that
        // would create it has been approved.
        targetMachineId: targetMachine?.id ?? null,
        ownerPersonId: input.target.kind === "new_machine" ? input.target.ownerPersonId : null,
        newMachineName: input.target.kind === "new_machine" ? (input.target.name ?? null) : null,
        confirmDestroysData:
          input.target.kind === "existing_machine" && input.target.confirmDestroysData === true,
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
        targetMachineId: targetMachine?.id ?? null,
        mode: input.mode,
        approvalId: approvalResult.id,
        approvalStatus: approvalResult.status,
        restored: false,
      } satisfies RestoreSnapshotResult;
    }

    // The provider work, BEFORE the event. `snapshot.restored` is the permanent claim
    // that a machine got its data back; writing it on approval alone — which is what this
    // did for its whole life — records a restore that never happened.
    const restoredMachineId =
      targetMachine === null
        ? yield* performRestoreIntoNewMachine(sourceMachine, dataDisk, {
            ownerPersonId: (input.target as { ownerPersonId: string }).ownerPersonId,
            ...(input.target.kind === "new_machine" && input.target.name !== undefined
              ? { name: input.target.name }
              : {}),
            actorPersonId: input.requestedByPersonId,
          })
        : yield* performRestoreOntoMachine(snapshot, targetMachine, dataDisk);

    if (restoredMachineId === null) {
      return yield* Effect.fail(
        new RestoreFailedError({
          snapshotId: snapshot.id,
          targetMachineId: targetMachine?.id ?? null,
        }),
      );
    }

    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({
            orgId: snapshot.orgId,
            machineId: restoredMachineId,
            correlationId,
            actorType: "person",
            actorId: input.requestedByPersonId,
          }),
          type: "snapshot.restored",
          payload: {
            mode: input.mode,
            targetMachineId: restoredMachineId,
            approvalId: approvalResult.id,
            createdNewMachine: targetMachine === null,
          },
        },
      ]),
    );

    return {
      snapshotId: snapshot.id,
      targetMachineId: restoredMachineId,
      mode: input.mode,
      approvalId: approvalResult.id,
      approvalStatus: "approved",
      restored: true,
    } satisfies RestoreSnapshotResult;
  });

/**
 * Replays the target a pending restore was approved for.
 *
 * Reads it off the persisted row rather than re-deciding: what was approved is what must
 * happen, and the machine's own state may well have moved since. A new-machine restore
 * creates the machine HERE, not at request time — provisioning one for a restore nobody
 * had approved would be exactly the thing the approval gate exists to prevent.
 */
const resumeTargetOf = (
  request: {
    targetKind: "new_machine" | "existing_machine";
    targetMachineId: string | null;
    ownerPersonId: string | null;
    newMachineName: string | null;
    requestedByPersonId: string;
  },
  snapshot: SnapshotRow,
  dataDisk: CapturedDisk,
  orgId: string,
) =>
  Effect.gen(function* () {
    if (request.targetKind === "new_machine") {
      if (!request.ownerPersonId) return null;
      const sourceMachine = yield* fetchMachine(snapshot.machineId, orgId).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!sourceMachine) return null;
      return yield* performRestoreIntoNewMachine(sourceMachine, dataDisk, {
        ownerPersonId: request.ownerPersonId,
        ...(request.newMachineName === null ? {} : { name: request.newMachineName }),
        actorPersonId: request.requestedByPersonId,
      });
    }

    if (!request.targetMachineId) return null;
    const targetMachine = yield* fetchMachine(request.targetMachineId, orgId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (!targetMachine) return null;
    return yield* performRestoreOntoMachine(snapshot, targetMachine, dataDisk);
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
  InvalidRestoreApprovalError | RestoreNotApprovedError | RestoreFailedError | ArchiveDbError,
  Db | EventBus | ApprovalService | ProvisioningServiceTag | MachineService
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

    // Same ordering rule as `restoreSnapshot`: the provider work happens first, and the
    // event and the completion marker only follow a restore that really happened. This
    // path published on approval alone too.
    const snapshot = yield* fetchSnapshot(restoreRequest.snapshotId, orgId).pipe(
      Effect.catchAll(() => Effect.fail(new InvalidRestoreApprovalError({ approvalId }))),
    );
    const dataDisk = dataDiskOf(snapshot);
    if (!dataDisk) {
      // The snapshot was restorable when the request was made; something has changed
      // since. Not completed, so it stays retryable once whoever is investigating knows.
      return yield* Effect.fail(
        new RestoreFailedError({
          snapshotId: restoreRequest.snapshotId,
          targetMachineId: restoreRequest.targetMachineId,
        }),
      );
    }

    const restoredMachineId = yield* resumeTargetOf(restoreRequest, snapshot, dataDisk, orgId);
    if (restoredMachineId === null) {
      return yield* Effect.fail(
        new RestoreFailedError({
          snapshotId: restoreRequest.snapshotId,
          targetMachineId: restoreRequest.targetMachineId,
        }),
      );
    }

    const eventBus = yield* EventBus;
    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({
            orgId,
            machineId: restoredMachineId,
            correlationId: ulid(),
            actorType: "person",
            actorId: restoreRequest.requestedByPersonId,
          }),
          type: "snapshot.restored",
          payload: {
            mode: restoreRequest.mode,
            targetMachineId: restoredMachineId,
            approvalId,
            createdNewMachine: restoreRequest.targetKind === "new_machine",
          },
        },
      ]),
    );
    yield* markRestoreRequestCompleted(approvalId, restoredMachineId).pipe(
      Effect.mapError(
        (cause) =>
          new ArchiveDbError({ reason: `mark_restore_request_completed_failed: ${cause.reason}` }),
      ),
    );

    return {
      snapshotId: restoreRequest.snapshotId,
      targetMachineId: restoredMachineId,
      mode: restoreRequest.mode,
      approvalId,
      approvalStatus: "approved",
      restored: true,
    } satisfies RestoreSnapshotResult;
  });
