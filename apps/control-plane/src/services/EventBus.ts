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
 * Shapes a batch of domain events into insertable `events` rows, assigning a
 * fresh ULID `id` and `recordedAt` to each — even if the caller already
 * populated those fields to satisfy `DomainEvent`'s type. Exported (in
 * addition to being used by `publish` below) so a caller that needs the
 * event insert to commit atomically with its own state change can run
 * `tx.insert(events).values(toEventRows(batch))` inside its own
 * transaction, instead of going through `publish`'s separate connection.
 *
 * Does NOT apply logging-tier filtering — that's `publish`'s job (see its
 * doc comment). A caller building its own transaction should filter first
 * via `filterByLoggingTier`, exactly as `publish` does, so no code path
 * writes an org's below-configured-tier events regardless of which
 * connection it goes through.
 */
export const toEventRows = (batch: ReadonlyArray<DomainEvent>) =>
  batch.map((event) => ({
    ...event,
    id: ulid(),
    recordedAt: new Date(),
  }));

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

        yield* Effect.tryPromise({
          try: () => db.insert(events).values(toEventRows(allowed)),
          catch: (cause) => new EventBusError({ reason: "insert_failed", cause }),
        });
      });

    return { publish } as const;
  }),
}) {}
