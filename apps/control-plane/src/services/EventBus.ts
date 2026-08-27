import { Data, Effect } from "effect";
import { ulid } from "ulid";
import type { DomainEvent } from "@cloudable/events";
import { events } from "@cloudable/schema";
import { Db } from "../db/layer";

export class EventBusError extends Data.TaggedError("EventBusError")<{
  reason: string;
  cause?: unknown;
}> {}

/**
 * Append-only event publication (CLAUDE.md invariant #2). `publish` assigns
 * a fresh ULID `id` and `recordedAt` to every event it is given — even if
 * the caller already populated those fields to satisfy `DomainEvent`'s
 * type — and bulk-inserts the batch. There is deliberately no update/delete
 * method on this service.
 */
export class EventBus extends Effect.Service<EventBus>()("EventBus", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const publish = (batch: ReadonlyArray<DomainEvent>): Effect.Effect<void, EventBusError> =>
      Effect.gen(function* () {
        if (batch.length === 0) return;

        const rows = batch.map((event) => ({
          ...event,
          id: ulid(),
          recordedAt: new Date(),
        }));

        yield* Effect.tryPromise({
          try: () => db.insert(events).values(rows),
          catch: (cause) => new EventBusError({ reason: "insert_failed", cause }),
        });
      });

    return { publish } as const;
  }),
}) {}
