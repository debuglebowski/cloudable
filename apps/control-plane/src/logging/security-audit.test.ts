import { describe, expect, test } from "bun:test";
import type { DomainEvent, PersonEvent } from "@cloudable/events";
import { toSecurityAuditRecord } from "./security-audit";

const envelope = {
  id: "persisted-event-id",
  occurredAt: new Date("2026-11-09T10:00:00Z"),
  recordedAt: new Date("2026-11-09T10:00:01Z"),
  orgId: "org-1",
  actorType: "person" as const,
  actorId: "admin-1",
  machineId: null,
  correlationId: "correlation-1",
  schemaVersion: 1,
};
const audit = (event: Pick<PersonEvent, "type" | "payload">) =>
  toSecurityAuditRecord({ ...envelope, ...event } as DomainEvent);

describe("security audit output", () => {
  test("covers role promotions, approver grants, privileged creation and reactivation", () => {
    const grants: Pick<PersonEvent, "type" | "payload">[] = [
      {
        type: "person.role_changed",
        payload: { personId: "target", previous: "member", current: "admin" },
      },
      {
        type: "person.role_changed",
        payload: { personId: "target", previous: "admin", current: "owner" },
      },
      {
        type: "person.approver_changed",
        payload: { personId: "target", previous: false, current: true },
      },
      {
        type: "person.added",
        payload: {
          personId: "target",
          email: "private@example.com",
          source: "manual",
          role: "owner",
        },
      },
      {
        type: "person.added",
        payload: {
          personId: "target",
          email: "private@example.com",
          source: "manual",
          role: "member",
          approver: true,
        },
      },
      { type: "person.activated", payload: { personId: "target", role: "admin" } },
      { type: "person.activated", payload: { personId: "target", approver: true } },
    ];
    for (const grant of grants) {
      expect(audit(grant)).toMatchObject({
        eventId: envelope.id,
        event: grant.type,
        subjectPersonId: "target",
        actorId: "admin-1",
        outcome: "success",
      });
    }
  });

  test("ignores revocations, no-ops, nonprivileged people and legacy lifecycle payloads", () => {
    const ignored: Pick<PersonEvent, "type" | "payload">[] = [
      { type: "person.role_changed", payload: { previous: "owner", current: "admin" } },
      { type: "person.role_changed", payload: { previous: "admin", current: "member" } },
      { type: "person.role_changed", payload: { previous: "owner", current: "owner" } },
      { type: "person.approver_changed", payload: { previous: true, current: false } },
      { type: "person.approver_changed", payload: { previous: true, current: true } },
      {
        type: "person.added",
        payload: {
          email: "private@example.com",
          source: "manual",
          role: "member",
          approver: false,
        },
      },
      { type: "person.activated", payload: {} },
      { type: "person.deactivated", payload: { source: "manual" } },
    ];
    for (const event of ignored) expect(audit(event)).toBeNull();
  });

  test("exports an explicit allowlist, never email or arbitrary payload fields", () => {
    const record = audit({
      type: "person.added",
      payload: {
        personId: "target",
        email: "private@example.com\nforged-record",
        source: "manual",
        role: "admin",
        secret: "must-not-leak",
      } as never,
    });
    expect(record).toEqual({
      source: "cloudable",
      type: "security",
      schemaVersion: 1,
      event: "person.added",
      eventId: envelope.id,
      outcome: "success",
      orgId: "org-1",
      actorType: "person",
      actorId: "admin-1",
      subjectPersonId: "target",
      occurredAt: "2026-11-09T10:00:00.000Z",
      recordedAt: "2026-11-09T10:00:01.000Z",
      detail: { role: "admin", approver: undefined },
    });
    expect(JSON.stringify(record)).not.toContain("private@example.com");
    expect(JSON.stringify(record)).not.toContain("must-not-leak");
  });
});
