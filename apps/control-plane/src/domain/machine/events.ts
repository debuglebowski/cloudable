import type { MachineEvent } from "@cloudable/events";

type ActorType = "person" | "system" | "agent" | "idp";

interface ActorContext {
  actorType: ActorType;
  actorId: string;
}

export interface MachineCreatedInput extends ActorContext {
  machineId: string;
  orgId: string;
  correlationId: string;
  name: string;
  region: string;
  size: string;
  image: string;
  occurredAt?: Date;
}

/**
 * `id`/`recordedAt` are placeholders — `EventBus.publish` (see
 * `apps/control-plane/src/services/EventBus.ts`) unconditionally assigns a
 * fresh ULID and timestamp to every event it appends, regardless of what a
 * caller passes. Derivation stays pure; only `EventBus` touches the store.
 */
const PLACEHOLDER_ID = "";
const PLACEHOLDER_RECORDED_AT = new Date(0);

export function machineCreatedEvent(input: MachineCreatedInput): MachineEvent {
  return {
    id: PLACEHOLDER_ID,
    type: "machine.created",
    occurredAt: input.occurredAt ?? new Date(),
    recordedAt: PLACEHOLDER_RECORDED_AT,
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    machineId: input.machineId,
    correlationId: input.correlationId,
    schemaVersion: 1,
    payload: { name: input.name, region: input.region, size: input.size, image: input.image },
  };
}

export interface MachineOwnerAssignedInput extends ActorContext {
  machineId: string;
  orgId: string;
  correlationId: string;
  personId: string;
  previousPersonId: string | null;
  occurredAt?: Date;
}

/**
 * CLAUDE.md invariant #3: a machine always has exactly one owner. Emitted
 * alongside `machine.created` (with `previousPersonId: null`) since
 * `MachineService.create` requires an owner up front, and again on any
 * future ownership transfer.
 */
export function machineOwnerAssignedEvent(input: MachineOwnerAssignedInput): MachineEvent {
  return {
    id: PLACEHOLDER_ID,
    type: "machine.owner_assigned",
    occurredAt: input.occurredAt ?? new Date(),
    recordedAt: PLACEHOLDER_RECORDED_AT,
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    machineId: input.machineId,
    correlationId: input.correlationId,
    schemaVersion: 1,
    payload: { personId: input.personId, previousPersonId: input.previousPersonId },
  };
}

export interface MachineSettingChangedInput extends ActorContext {
  machineId: string;
  orgId: string;
  correlationId: string;
  /** The manifest/setting key, e.g. a package name. */
  key: string;
  previous: unknown;
  current: unknown;
  /** The scope level whose value this change now overrides (or "none"). */
  overridesLevel: string;
  occurredAt?: Date;
}

export function machineSettingChangedEvent(input: MachineSettingChangedInput): MachineEvent {
  return {
    id: PLACEHOLDER_ID,
    type: "machine.setting_changed",
    occurredAt: input.occurredAt ?? new Date(),
    recordedAt: PLACEHOLDER_RECORDED_AT,
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    machineId: input.machineId,
    correlationId: input.correlationId,
    schemaVersion: 1,
    payload: {
      key: input.key,
      previous: input.previous,
      current: input.current,
      overridesLevel: input.overridesLevel,
    },
  };
}
