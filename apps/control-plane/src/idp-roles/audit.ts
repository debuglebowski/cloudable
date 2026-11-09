import type { DomainEvent } from "@cloudable/events";
import { type AuditEvent, buildAuditEvent } from "./contract";

/**
 * A shared-contract audit event as a Cloudable domain event: same name, same fields, in the
 * append-only `events` table. `actorType` says who acted in Cloudable's own terms.
 */
export const toDomainEvent = (
  audit: AuditEvent,
  envelope: {
    orgId: string;
    actorType: DomainEvent["actorType"];
    actorId: string;
    correlationId: string;
    at: Date;
  },
): DomainEvent => {
  const { event, ...payload } = buildAuditEvent(audit);
  return {
    // Both replaced by `toEventRows` / `EventBus.publish`.
    id: "",
    recordedAt: envelope.at,
    occurredAt: envelope.at,
    orgId: envelope.orgId,
    actorType: envelope.actorType,
    actorId: envelope.actorId,
    machineId: null,
    correlationId: envelope.correlationId,
    schemaVersion: 1,
    type: event,
    payload,
  } as DomainEvent;
};

/**
 * The security log line for one audit event: `[security] idp-roles <json>`, the allowlisted
 * fields only. Called after the change commits, so the log never claims what did not happen.
 */
export const logAudit = (audit: AuditEvent): void => {
  const line = `[security] idp-roles ${JSON.stringify(buildAuditEvent(audit))}`;
  if (audit.event === "idp_roles.denied" || audit.event === "idp_roles.local_change_refused") {
    console.warn(line);
  } else {
    console.log(line);
  }
};
