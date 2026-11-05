// ---------------------------------------------------------------------------
// Changing approval settings takes two people: an admin asks, an approver
// signs off. Until then nothing changes.
//
// Without this, an admin could set a mode to "none" and then do the thing the
// mode was guarding, alone. The request is an ordinary approval of type
// `approval_settings_change`, which `ApprovalService.request` never lets
// resolve to "none", and which only an approver (not just any admin) may
// decide (see `http/handlers/approvals.ts`). The requested modes are stored on
// the approval, so what the approver saw is exactly what gets applied.
//
// `PATCH /api/v1/organisation` and `PATCH /api/v1/config/settings` refuse
// `approval_mode:*` keys outright, so this is the only way in.
// ---------------------------------------------------------------------------
import { Effect, Schema } from "effect";
import type { Db } from "../../db/layer";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import type { EventBus } from "../../services/EventBus";
import type { TunnelServer } from "../../tunnel/server";
import {
  APPROVAL_ACTION_TYPES,
  type ApprovalActionType,
  type ApprovalMode,
  OrgSettingsError,
  getOrgSettings,
  updateOrgSettings,
} from "./settings";

const ApprovalModesPayload = Schema.Struct({
  approvalModes: Schema.partial(
    Schema.Record({
      key: Schema.Literal(...APPROVAL_ACTION_TYPES),
      value: Schema.Literal("none", "single", "dual"),
    }),
  ),
});

export const decodeApprovalModesPayload = Schema.decodeUnknownOption(ApprovalModesPayload);

/** Asks for the change. Only the modes that actually differ from today's are kept. */
export const requestApprovalSettingsChange = (input: {
  orgId: string;
  personId: string;
  approvalModes: { [K in ApprovalActionType]?: ApprovalMode | undefined };
  reason: string;
}): Effect.Effect<ApprovalResult, OrgSettingsError, Db | ApprovalService> =>
  Effect.gen(function* () {
    const current = yield* getOrgSettings(input.orgId);
    const changed: { [K in ApprovalActionType]?: ApprovalMode } = {};
    for (const actionType of APPROVAL_ACTION_TYPES) {
      const next = input.approvalModes[actionType];
      if (next !== undefined && next !== current.approvalModes[actionType]) {
        changed[actionType] = next;
      }
    }
    if (Object.keys(changed).length === 0) {
      return yield* Effect.fail(new OrgSettingsError({ reason: "no_approval_mode_change" }));
    }
    const approvalService = yield* ApprovalService;
    return yield* approvalService
      .request({
        orgId: input.orgId,
        actionType: "approval_settings_change",
        requestedByPersonId: input.personId,
        targetMachineId: null,
        reason: input.reason,
        payload: { approvalModes: changed },
      })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "reason_required"
            ? new OrgSettingsError({ reason: "reason_required" })
            : new OrgSettingsError({ reason: "approval_request_failed", cause: error }),
        ),
      );
  });

/**
 * Applies a granted change. The setting events name the admin who asked as the actor; the
 * approval's own `approval.granted` event names who signed off, under the same approval.
 */
export const applyApprovalSettingsChange = (
  approval: ApprovalResult,
): Effect.Effect<void, OrgSettingsError, Db | EventBus | TunnelServer> =>
  Effect.gen(function* () {
    const decoded = decodeApprovalModesPayload(approval.payload);
    if (decoded._tag === "None") {
      return yield* Effect.fail(new OrgSettingsError({ reason: "approval_payload_unreadable" }));
    }
    yield* updateOrgSettings({
      orgId: approval.orgId,
      approvalModes: decoded.value.approvalModes,
      actor: { actorType: "person", actorId: approval.requestedByPersonId },
    });
  });
