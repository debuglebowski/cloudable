import type { DomainEvent } from "@cloudable/events";
import { ulid } from "ulid";

/**
 * Small typed helper for constructing a single `DomainEvent` of a given
 * `type`, filling in `id`/`occurredAt`/`recordedAt`/`schemaVersion`
 * consistently. `EventBus.publish` reassigns `id` and `recordedAt` on
 * insert regardless (see `services/EventBus.ts`), so the values here mostly
 * exist to satisfy the type — but are still real, unique, and
 * chronologically sane in case a caller inspects the event before
 * publishing (e.g. in a test).
 *
 * Shared across domain modules that emit events directly (offboarding,
 * archive) rather than duplicated per file.
 */
export function buildEvent<T extends DomainEvent["type"]>(
  type: T,
  fields: {
    orgId: string;
    actorType: DomainEvent["actorType"];
    actorId: string;
    machineId: string | null;
    correlationId: string;
    payload: Extract<DomainEvent, { type: T }>["payload"];
  },
): Extract<DomainEvent, { type: T }> {
  const now = new Date();
  return {
    id: ulid(),
    type,
    occurredAt: now,
    recordedAt: now,
    schemaVersion: 1,
    ...fields,
  } as unknown as Extract<DomainEvent, { type: T }>;
}
