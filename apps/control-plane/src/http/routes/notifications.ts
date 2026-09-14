import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { NotificationInfraError } from "../../domain/notifications/errors";
import { CurrentUserAuthentication } from "../middleware/auth";

// `/api/v1/notifications` — the read side of the owner-notification flow
// (see `../../domain/elevation/notify.ts` for the write side). Both
// endpoints are `CurrentUserAuthentication`-gated and read the org and the
// person from `CurrentUserTag`.
//
// `orgId` and `personId` used to travel as plain query params on a group
// with no middleware, described here as a stopgap until auth landed. Auth
// landed; this did not follow. A notification is addressed to one person,
// so an unauthenticated `personId` meant anyone could read — and bulk
// mark-read — anyone else's notifications by passing their id.
//
// Returns every notification for that person, newest first, read and
// unread alike (small dataset — one row per elevation grant) — the console
// nav badge filters to unread client-side (`apps/console/src/api/
// notifications.ts`), the same way it already treats Approvals' pending
// list as the badge count.

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

export const MarkNotificationsReadResponse = Schema.Struct({
  updated: Schema.Number,
});

export const NotificationsGroup = HttpApiGroup.make("notifications")
  .add(
    HttpApiEndpoint.get("list", "/api/v1/notifications")
      .addSuccess(ListNotificationsResponse)
      .addError(NotificationInfraError, { status: 500 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    // Bulk mark-read (no per-notification UI exists yet — see
    // `domain/notifications/queries.ts`'s `markAllNotificationsRead` doc
    // comment). Marks the CALLER's own notifications read: there is no
    // payload, and no way to name someone else's.
    HttpApiEndpoint.post("markRead", "/api/v1/notifications/read")
      .addSuccess(MarkNotificationsReadResponse)
      .addError(NotificationInfraError, { status: 500 })
      .middleware(CurrentUserAuthentication),
  );
