import type { EventEnvelope } from "@cloudable/events";

/** Builds the shared envelope fields for an event. `id` and `recordedAt` are
 * placeholders — `EventBus.publish` always overwrites both with a fresh ULID and the
 * actual write time, regardless of what's passed in (see `services/EventBus.ts`). */
export function makeEnvelope(input: {
  orgId: string;
  machineId: string | null;
  correlationId: string;
  actorType: EventEnvelope["actorType"];
  actorId: string;
}): EventEnvelope {
  const now = new Date();
  return {
    id: "",
    occurredAt: now,
    recordedAt: now,
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    machineId: input.machineId,
    correlationId: input.correlationId,
    schemaVersion: 1,
  };
}

/** Default actor for archive-lifecycle events with no human directly attributable —
 * see the `archiveMachine`/`createSnapshot` doc comments for when this applies. */
export const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "system" };
