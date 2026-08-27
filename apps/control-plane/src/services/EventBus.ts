import type { DomainEvent } from "@cloudable/events";
import { events } from "@cloudable/schema";
import { Data, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../db/layer";
import { filterByLoggingTier } from "../logging/tier-filter";

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
 *
 * Before inserting, `publish` drops tier-2/3 events whose org is configured
 * (spec §17) below that event's minimum tier — see `../logging/tier-filter`.
 * Tier-1 events (the compliance floor) are never dropped. This lives inside
 * `publish` itself, rather than a separate wrapper, so every existing and
 * future caller of `EventBus.publish` gets tier filtering for free.
 */
export class EventBus extends Effect.Service<EventBus>()("EventBus", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const publish = (batch: ReadonlyArray<DomainEvent>): Effect.Effect<void, EventBusError> =>
      Effect.gen(function* () {
        if (batch.length === 0) return;

        const allowed = yield* filterByLoggingTier(db, batch).pipe(
          Effect.mapError((cause) => new EventBusError({ reason: "tier_lookup_failed", cause })),
        );
        if (allowed.length === 0) return;

        const rows = allowed.map((event) => ({
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
