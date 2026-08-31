import { Effect } from "effect";
import type { ElevationRepo } from "./ElevationRepo";
import type { Elevation } from "./types";

// Deliberately not shared with `apps/console/src/api/access.ts`'s
// ELEVATION_LEVEL_LABEL: that one feeds a UI badge in a separate app
// (console can't import control-plane's server-side code); this one feeds
// a persisted message string, baked into the notification row at write
// time rather than resolved from `elevation.level` at render time.
const LEVEL_LABEL: Record<Elevation["level"], string> = {
  file_recovery: "file recovery",
  shell: "interactive shell",
};

function buildMessage(machineName: string, elevation: Elevation): string {
  const level = LEVEL_LABEL[elevation.level];
  const expiry = elevation.expiresAt ? elevation.expiresAt.toISOString() : "unknown";
  return `An admin (person ${elevation.personId}) was granted ${level} access to your machine "${machineName}". Access expires ${expiry}.`;
}

/**
 * Notify a machine's owner that an admin was granted elevated access to
 * their machine (spec §15: "owner notified"). Only called when the machine
 * has a live owner — an elevation against a machine mid-offboarding
 * (`ownerPersonId` cleared) has nobody to notify.
 *
 * In-app/console notification only — no email, no Slack, no new external
 * provider or secret (explicit product decision). Persists one row via the
 * caller's `insertNotification` (the `notifications` table, see
 * `packages/schema/src/tables/notification.ts`) that the owner's own
 * session can later list via `GET /api/v1/notifications`
 * (`domain/notifications/queries.ts` + `http/routes/notifications.ts`), and
 * that the console surfaces as an unread nav badge — same
 * `NAV_BADGE_HOOKS` mechanism Approvals already uses (see
 * `apps/console/src/nav-config.ts`).
 *
 * Takes `insertNotification` as a plain parameter rather than yielding
 * `ElevationRepoTag` itself: every call site in `ElevationService.ts`
 * already has the resolved `ElevationRepo` (its own persistence port,
 * fetched once via `yield*` when the service is constructed) sitting in
 * closure, and every other repo call in that file is a plain, already-
 * resolved `Effect.Effect<_, Error>` with no further context requirement —
 * re-yielding the tag in here would leak `ElevationRepoTag` into
 * `request`/`syncApproval`'s declared (context-free) return types instead.
 */
export function notifyOwnerOfElevation(
  insertNotification: ElevationRepo["insertNotification"],
  ownerPersonId: string,
  machineName: string,
  elevation: Elevation,
): Effect.Effect<void, Error> {
  return Effect.asVoid(
    insertNotification({
      orgId: elevation.orgId,
      ownerPersonId,
      elevationId: elevation.id,
      message: buildMessage(machineName, elevation),
      now: new Date(),
    }),
  );
}
