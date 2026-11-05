// ---------------------------------------------------------------------------
// What happens when the last approver says yes, for the approval types whose
// action is carried out by the control plane itself rather than resumed by the
// person who asked (restore, offboarding and elevation each have a `sync`
// endpoint the requester calls; see their handlers).
//
// Runs once per approval: `ApprovalService.decide` flips a request to
// `approved` exactly once, under a row lock, and only that call reaches here.
// ---------------------------------------------------------------------------
import { Effect } from "effect";
import type { Db } from "../../db/layer";
import type { ApprovalResult } from "../../services/ApprovalService";
import type { EventBus } from "../../services/EventBus";
import type { TunnelServer } from "../../tunnel/server";
import { decodePackageInstallPayload, queuePackageAction } from "../machine/package-request";
import { applyApprovalSettingsChange } from "../organisation/approval-settings-change";

export const carryOutApproved = (
  approval: ApprovalResult,
): Effect.Effect<void, never, Db | EventBus | TunnelServer> => {
  if (approval.status !== "approved") return Effect.void;
  switch (approval.actionType) {
    case "package_install": {
      const payload = decodePackageInstallPayload(approval.payload);
      if (payload._tag === "None" || approval.targetMachineId === null) {
        return Effect.logError(`approval ${approval.id}: package_install payload unreadable`);
      }
      return queuePackageAction({
        machineId: approval.targetMachineId,
        orgId: approval.orgId,
        requestedByPersonId: approval.requestedByPersonId,
        payload: payload.value,
      }).pipe(
        Effect.asVoid,
        // The approval stands either way; it is evidence of the decision. The usual reason
        // this fails is another action on the same package still waiting, and the person can
        // ask again once it settles.
        Effect.catchAll((error) =>
          Effect.logWarning(
            `approval ${approval.id}: granted, but the package action was not queued: ${error.error.message}`,
          ),
        ),
      );
    }
    case "approval_settings_change":
      return applyApprovalSettingsChange(approval).pipe(
        Effect.catchAll((error) =>
          Effect.logError(
            `approval ${approval.id}: granted, but the settings were not applied: ${error.reason}`,
          ),
        ),
      );
    default:
      return Effect.void;
  }
};
