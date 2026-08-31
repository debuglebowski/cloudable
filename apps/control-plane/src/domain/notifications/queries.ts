import { notifications } from "@cloudable/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

export class NotificationQueryError extends Data.TaggedError("NotificationQueryError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface NotificationListRow {
  id: string;
  elevationId: string;
  message: string;
  createdAt: Date;
  readAt: Date | null;
}

/**
 * Org- and person-scoped notification list, newest first — the read side
 * the console polls to badge the nav item (spec §15: "owner notified"),
 * exactly mirroring `../elevation/queries.ts`'s split: writes go through
 * `ElevationRepo` (the narrow, mockable port `ElevationService` depends on
 * — see `../elevation/notify.ts`), reads are a separate, plain-`Db`
 * function with no bearing on the grant/deny state machine. Small dataset
 * (one row per elevation grant), so no cursor pagination.
 */
export const listNotificationsForPerson = (
  orgId: string,
  personId: string,
): Effect.Effect<NotificationListRow[], NotificationQueryError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: notifications.id,
            elevationId: notifications.elevationId,
            message: notifications.message,
            createdAt: notifications.createdAt,
            readAt: notifications.readAt,
          })
          .from(notifications)
          .where(and(eq(notifications.orgId, orgId), eq(notifications.ownerPersonId, personId)))
          .orderBy(desc(notifications.createdAt)),
      catch: (cause) => new NotificationQueryError({ reason: "query_failed", cause }),
    });
  });

/**
 * Marks every currently-unread notification for this org+person as read.
 * Bulk rather than per-id: there is no console page listing individual
 * notifications yet (see `apps/console/src/nav-config.ts`'s doc comment on
 * the `/access` badge) — the console instead marks the whole set read once
 * the owner visits the Access page the badge points to. Returns the count
 * actually flipped, for callers that want to know whether there was
 * anything to mark.
 */
export const markAllNotificationsRead = (
  orgId: string,
  personId: string,
): Effect.Effect<number, NotificationQueryError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* Effect.tryPromise({
      try: () =>
        db
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.orgId, orgId),
              eq(notifications.ownerPersonId, personId),
              isNull(notifications.readAt),
            ),
          )
          .returning({ id: notifications.id }),
      catch: (cause) => new NotificationQueryError({ reason: "mark_read_failed", cause }),
    });
    return updated.length;
  });
