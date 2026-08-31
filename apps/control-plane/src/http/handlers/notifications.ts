import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { NotificationInfraError } from "../../domain/notifications/errors";
import {
  listNotificationsForPerson,
  markAllNotificationsRead,
} from "../../domain/notifications/queries";
import { Api } from "../api";

const asInfraError = (e: { reason: string }) => new NotificationInfraError({ reason: e.reason });

export const NotificationsLive = HttpApiBuilder.group(Api, "notifications", (handlers) =>
  handlers
    .handle("list", ({ urlParams }) =>
      listNotificationsForPerson(urlParams.orgId, urlParams.personId).pipe(
        Effect.map((rows) => ({
          items: rows.map((row) => ({
            id: row.id,
            elevationId: row.elevationId,
            message: row.message,
            createdAt: row.createdAt.toISOString(),
            readAt: row.readAt ? row.readAt.toISOString() : null,
          })),
        })),
        Effect.catchTag("NotificationQueryError", (e) => Effect.fail(asInfraError(e))),
      ),
    )
    .handle("markRead", ({ payload }) =>
      markAllNotificationsRead(payload.orgId, payload.personId).pipe(
        Effect.map((updated) => ({ updated })),
        Effect.catchTag("NotificationQueryError", (e) => Effect.fail(asInfraError(e))),
      ),
    ),
);
