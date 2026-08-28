import { Effect } from "effect";
import type { Elevation } from "./types";

/**
 * Notify a machine's owner that an admin was granted elevated access to
 * their machine (spec §15: "owner notified"). Only called when the machine
 * has a live owner — an elevation against a machine mid-offboarding
 * (`ownerPersonId` cleared) has nobody to notify.
 *
 * STUB — this is the integration point for a future email/Slack/in-app
 * notifier. For now it just logs, so the grant path always has *something*
 * observable happen on every grant, and so nothing downstream needs to
 * change when a real notifier lands here.
 */
export function notifyOwnerOfElevation(
  ownerPersonId: string,
  machineId: string,
  elevation: Elevation,
): Effect.Effect<void> {
  return Effect.logInfo("elevation granted against a machine with a live owner — notifying owner", {
    ownerPersonId,
    machineId,
    elevationId: elevation.id,
    level: elevation.level,
    expiresAt: elevation.expiresAt,
  });
}
