// ---------------------------------------------------------------------------
// A person asking for a package change on a machine (invariant 4: a person
// asks, per package, and it is recorded).
//
// Installs go through an approval (`package_install`, default mode `single`,
// set on the Organisation page). Removals do not: taking a package away
// cannot widen what a machine can do. When the org's mode for installs is
// `none`, the approval is granted on the spot and the action is queued in the
// same request, so the record is the same either way.
//
// The action is queued by `queueApprovedPackageAction` below, which runs at
// most once per approval: right here when no sign-off is needed, or from the
// approvals handler when the last approver says yes.
// ---------------------------------------------------------------------------
import { isValidPackageName } from "@cloudable/contracts";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { MachineService } from "./MachineService";
import { PackageActionRejected } from "./errors";
import { machinePackageActionRequestedEvent } from "./events";
import { type ActionRow, type PackageActionError, enqueuePackageAction } from "./package-actions";

export interface PackageInstallPayload {
  readonly packageName: string;
  readonly op: "install" | "uninstall";
  readonly versionPin: string | null;
  readonly isBaselinePackage: boolean;
}

const PackageInstallPayloadSchema = Schema.Struct({
  packageName: Schema.String,
  op: Schema.Literal("install", "uninstall"),
  versionPin: Schema.NullOr(Schema.String),
  isBaselinePackage: Schema.Boolean,
});

export const decodePackageInstallPayload = Schema.decodeUnknownOption(PackageInstallPayloadSchema);

type RejectionCode = PackageActionRejected["error"]["code"];

const rejected = (code: RejectionCode, message: string, requestId: string) =>
  new PackageActionRejected({ error: { code, message, requestId } });

const toRejected = (error: PackageActionError, requestId: string) =>
  rejected(
    error.reason === "machine_not_found" ? "write_failed" : error.reason,
    error.message,
    requestId,
  );

/** Queues the action and records `machine.package_action_requested`, attributed to the person who asked. */
export const queuePackageAction = (input: {
  machineId: string;
  orgId: string;
  requestedByPersonId: string;
  payload: PackageInstallPayload;
}): Effect.Effect<ActionRow, PackageActionRejected, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const correlationId = ulid();
    const action = yield* enqueuePackageAction(db, {
      machineId: input.machineId,
      orgId: input.orgId,
      packageName: input.payload.packageName,
      op: input.payload.op,
      versionPin: input.payload.versionPin,
      requestedByPersonId: input.requestedByPersonId,
      correlationId,
      isBaselinePackage: input.payload.isBaselinePackage,
    }).pipe(Effect.mapError((error) => toRejected(error, correlationId)));

    yield* eventBus
      .publish([
        machinePackageActionRequestedEvent({
          machineId: input.machineId,
          orgId: input.orgId,
          correlationId,
          actorType: "person",
          actorId: input.requestedByPersonId,
          actionId: action.id,
          packageName: action.packageName,
          op: action.op,
          versionPin: action.versionPin,
        }),
      ])
      .pipe(Effect.orDie);
    return action;
  });

/**
 * The caller has already passed `authorizeMachine(user, machineId, "packages")`. Validates the
 * request up front, so an approver is never asked about something that could not be carried out,
 * then either queues it (a removal) or asks for an approval (an install).
 */
export const requestPackageAction = (input: {
  machineId: string;
  orgId: string;
  personId: string;
  packageName: string;
  op: "install" | "uninstall";
  reason: string | undefined;
}): Effect.Effect<
  { action: ActionRow | null; approval: ApprovalResult | null },
  PackageActionRejected,
  Db | EventBus | MachineService | ApprovalService
> =>
  Effect.gen(function* () {
    const requestId = ulid();
    if (!isValidPackageName(input.packageName)) {
      return yield* Effect.fail(
        rejected(
          "invalid_package_name",
          `"${input.packageName}" is not a valid package name.`,
          requestId,
        ),
      );
    }
    const machineService = yield* MachineService;
    const view = yield* machineService
      .packagesView(input.machineId, input.orgId)
      // The caller already checked the machine is there and theirs to ask about.
      .pipe(
        Effect.catchTags({ MachineServiceError: Effect.die, MachineNotFoundError: Effect.die }),
      );
    const row = view.items.find((item) => item.packageName === input.packageName);
    const payload: PackageInstallPayload = {
      packageName: input.packageName,
      op: input.op,
      versionPin: row?.versionPin ?? null,
      isBaselinePackage: row?.isBaseline ?? false,
    };
    if (payload.isBaselinePackage) {
      return yield* Effect.fail(
        rejected(
          "baseline_package",
          `"${input.packageName}" came with this machine's image and cannot be installed or removed from here.`,
          requestId,
        ),
      );
    }

    if (input.op === "uninstall") {
      const action = yield* queuePackageAction({
        machineId: input.machineId,
        orgId: input.orgId,
        requestedByPersonId: input.personId,
        payload,
      });
      return { action, approval: null };
    }

    const approvalService = yield* ApprovalService;
    const reason = input.reason?.trim() || `Install ${input.packageName}`;
    const approval = yield* approvalService
      .request({
        orgId: input.orgId,
        actionType: "package_install",
        requestedByPersonId: input.personId,
        targetMachineId: input.machineId,
        reason,
        payload,
      })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "reason_required"
            ? rejected("reason_required", "A reason is required.", requestId)
            : rejected("write_failed", "The approval request could not be recorded.", requestId),
        ),
      );

    if (approval.status !== "approved") return { action: null, approval };
    const action = yield* queuePackageAction({
      machineId: input.machineId,
      orgId: input.orgId,
      requestedByPersonId: input.personId,
      payload,
    });
    return { action, approval };
  });
