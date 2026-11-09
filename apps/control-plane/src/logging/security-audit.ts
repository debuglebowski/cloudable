import type { DomainEvent } from "@cloudable/events";

type GrantDetail = {
  role?: string | undefined;
  previousRole?: string;
  approver?: boolean | undefined;
  previousApprover?: boolean;
};

const isAdmin = (role: string | undefined) => role === "admin" || role === "owner";

/** Only permission grants, with an explicit field allowlist. Never export the full payload. */
export const toSecurityAuditRecord = (event: DomainEvent) => {
  const record = (personId: string | undefined, detail: GrantDetail) => ({
    source: "cloudable",
    type: "security",
    schemaVersion: 1,
    event: event.type,
    eventId: event.id,
    outcome: "success",
    orgId: event.orgId,
    actorType: event.actorType,
    actorId: event.actorId,
    subjectPersonId: personId ?? null,
    occurredAt: event.occurredAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    detail,
  });

  switch (event.type) {
    case "person.added":
    case "person.activated": {
      const { personId, role, approver } = event.payload;
      return isAdmin(role) || approver === true ? record(personId, { role, approver }) : null;
    }
    case "person.role_changed": {
      const { personId, previous, current } = event.payload;
      return isAdmin(current) &&
        previous !== current &&
        !(previous === "owner" && current === "admin")
        ? record(personId, { previousRole: previous, role: current })
        : null;
    }
    case "person.approver_changed": {
      const { personId, previous, current } = event.payload;
      return current && !previous
        ? record(personId, { previousApprover: previous, approver: current })
        : null;
    }
    default:
      return null;
  }
};
