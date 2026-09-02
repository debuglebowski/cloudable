import type { DomainEvent } from "@cloudable/events";
import type { Elevation } from "./types";

/**
 * Builds the three `access.elevation_*` events (see `packages/events`
 * `domains/access.ts`). `EventBus.publish` fills in `id` and `recordedAt` —
 * everything else is ours to supply.
 */
export interface EventContext {
  orgId: string;
  actorType: "person" | "system" | "agent" | "idp";
  actorId: string;
  machineId: string;
  correlationId: string;
  occurredAt: Date;
}

export function buildElevationRequestedEvent(elevation: Elevation, ctx: EventContext): DomainEvent {
  if (!elevation.approvalId) {
    throw new Error(
      "buildElevationRequestedEvent: elevation has no approvalId — every elevation (even org policy 'always', " +
        "which auto-approves) is backed by a real approvals row before this event is built",
    );
  }
  return {
    id: "", // overwritten by EventBus.publish
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.occurredAt, // overwritten by EventBus.publish
    orgId: ctx.orgId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    machineId: ctx.machineId,
    correlationId: ctx.correlationId,
    schemaVersion: 1,
    type: "access.elevation_requested",
    payload: {
      level: elevation.level,
      reason: elevation.reason,
      approvalId: elevation.approvalId,
    },
  };
}

export function buildElevationGrantedEvent(elevation: Elevation, ctx: EventContext): DomainEvent {
  if (!elevation.expiresAt || !elevation.approvalId) {
    throw new Error(
      "buildElevationGrantedEvent: elevation has no expiresAt/approvalId — grant it before emitting this event",
    );
  }
  return {
    id: "",
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.occurredAt,
    orgId: ctx.orgId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    machineId: ctx.machineId,
    correlationId: ctx.correlationId,
    schemaVersion: 1,
    type: "access.elevation_granted",
    payload: {
      level: elevation.level,
      expiresAt: elevation.expiresAt.toISOString(),
      approvalId: elevation.approvalId,
    },
  };
}

/**
 * The org policy `"always"` (admin access to an unowned machine)
 * auto-approves by inserting an `approvals` row directly
 * (`ElevationRepo.insertAutoApprovedApproval`) rather than going through
 * `ApprovalService.request()` — so unlike the `with_approval` branch, no
 * `approval.granted` event exists unless this builds one. Without it, the
 * `elevated-access-approved` compliance check (which cross-references
 * `access.elevation_granted`'s `correlationId` against `approval.granted`
 * events) permanently flags every `"always"`-policy elevation as a
 * violation — the opposite of what the policy represents. Mirrors
 * `ApprovalService.request()`'s own `"none"`-mode auto-approval event
 * exactly (`approverIds: []`, since no human approver acted).
 */
export function buildAutoApprovalGrantedEvent(ctx: EventContext, actionType: string): DomainEvent {
  return {
    id: "",
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.occurredAt,
    orgId: ctx.orgId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    machineId: ctx.machineId,
    correlationId: ctx.correlationId,
    schemaVersion: 1,
    type: "approval.granted",
    payload: { approverIds: [], actionType },
  };
}

export function buildElevationExpiredEvent(elevation: Elevation, ctx: EventContext): DomainEvent {
  return {
    id: "",
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.occurredAt,
    orgId: ctx.orgId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    machineId: ctx.machineId,
    correlationId: ctx.correlationId,
    schemaVersion: 1,
    type: "access.elevation_expired",
    payload: { level: elevation.level },
  };
}
