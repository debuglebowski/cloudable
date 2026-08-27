import type { DomainEvent } from "@cloudable/events";
import { events } from "@cloudable/schema";
import { Data, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../db/layer";

export class EventBusError extends Data.TaggedError("EventBusError")<{
  reason: string;
  cause?: unknown;
}> {}

/**
 * Shapes a batch of domain events into insertable `events` rows, assigning a
 * fresh ULID `id` and `recordedAt` to each — even if the caller already
 * populated those fields to satisfy `DomainEvent`'s type. Exported (in
 * addition to being used by `publish` below) so a caller that needs the
 * event insert to commit atomically with its own state change can run
 * `tx.insert(events).values(toEventRows(batch))` inside its own
 * transaction, instead of going through `publish`'s separate connection.
 */
export const toEventRows = (batch: ReadonlyArray<DomainEvent>) =>
  batch.map((event) => ({
    ...event,
    id: ulid(),
    recordedAt: new Date(),
  }));

/**
 * Append-only event publication (CLAUDE.md invariant #2). There is
 * deliberately no update/delete method on this service.
 */
export class EventBus extends Effect.Service<EventBus>()("EventBus", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const publish = (batch: ReadonlyArray<DomainEvent>): Effect.Effect<void, EventBusError> =>
      Effect.gen(function* () {
        if (batch.length === 0) return;

        yield* Effect.tryPromise({
          try: () => db.insert(events).values(toEventRows(batch)),
          catch: (cause) => new EventBusError({ reason: "insert_failed", cause }),
        });
      });

    return { publish } as const;
  }),
}) {}
