import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { NotificationInfraError } from "../../domain/notifications/errors";

// `/api/v1/notifications` — the read side of the owner-notification flow
// (spec §15: "owner notified"; see `../../domain/elevation/notify.ts` for
// the write side). No `CurrentUserTag` auth middleware exists yet (see
// `../middleware/auth.ts`), so — same stopgap as every other endpoint in
// this build — `orgId` and `personId` travel as plain, unauthenticated
// query params rather than being derived from a session.
//
// Returns every notification for that person, newest first, read and
// unread alike (small dataset — one row per elevation grant) — the console
// nav badge filters to unread client-side (`apps/console/src/api/
// notifications.ts`), the same way it already treats Approvals' pending
// list as the badge count.

export const ListNotificationsUrlParams = Schema.Struct({
  orgId: Schema.String,
  personId: Schema.String,
});

export const NotificationItemSchema = Schema.Struct({
  id: Schema.String,
  elevationId: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
  readAt: Schema.NullOr(Schema.String),
});

export const ListNotificationsResponse = Schema.Struct({
  items: Schema.Array(NotificationItemSchema),
});

export const MarkNotificationsReadPayload = Schema.Struct({
  orgId: Schema.String,
  personId: Schema.String,
});

export const MarkNotificationsReadResponse = Schema.Struct({
  updated: Schema.Number,
});

export const NotificationsGroup = HttpApiGroup.make("notifications")
  .add(
    HttpApiEndpoint.get("list", "/api/v1/notifications")
      .setUrlParams(ListNotificationsUrlParams)
      .addSuccess(ListNotificationsResponse)
      .addError(NotificationInfraError, { status: 500 }),
  )
  .add(
    // Bulk mark-read (no per-notification UI exists yet — see
    // `domain/notifications/queries.ts`'s `markAllNotificationsRead` doc
    // comment). `personId` in the payload is the same unauthenticated
    // stopgap as everywhere else here, not an ownership check — a future
    // auth unit should scope this to `CurrentUserTag` instead.
    HttpApiEndpoint.post("markRead", "/api/v1/notifications/read")
      .setPayload(MarkNotificationsReadPayload)
      .addSuccess(MarkNotificationsReadResponse)
      .addError(NotificationInfraError, { status: 500 }),
  );
