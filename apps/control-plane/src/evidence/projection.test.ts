import { describe, expect, test } from "bun:test";
import { type RawEventRow, projectEvent } from "./projection";

const baseRow = (overrides: Partial<RawEventRow>): RawEventRow => ({
  id: "01J000000000000000000000",
  type: "machine.created",
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  recordedAt: new Date("2026-01-01T00:00:01Z"),
  orgId: "org-1",
  actorType: "person",
  actorId: "person-1",
  machineId: null,
  correlationId: "corr-1",
  schemaVersion: 1,
  payload: {},
  ...overrides,
});

describe("evidence projection (spec §18)", () => {
  test("projects the stable normalised shape", () => {
    const row = baseRow({
      type: "machine.created",
      payload: { name: "dev-box", region: "eastus", size: "Standard_B2s", image: "ubuntu-24.04" },
    });

    const record = projectEvent(row);

    expect(record).toEqual({
      id: row.id,
      type: "machine.created",
      occurredAt: "2026-01-01T00:00:00.000Z",
      recordedAt: "2026-01-01T00:00:01.000Z",
      orgId: "org-1",
      actor: { type: "person", id: "person-1" },
      machineId: null,
      correlationId: "corr-1",
      summary: 'Machine "dev-box" was declared (eastus, Standard_B2s, ubuntu-24.04).',
      commandRecording: null,
    });
  });

  test("attaches a commandRecording pointer without embedding raw command data", () => {
    const row = baseRow({
      type: "access.session_started",
      actorType: "person",
      payload: { method: "terminal", osUser: "ubuntu" },
    });

    const record = projectEvent(row, 42);

    expect(record.commandRecording).toEqual({ correlationId: "corr-1", count: 42 });
    // The projection is a pointer (correlationId + count), never the raw
    // command rows themselves (spec §17/§18 — never merged into the stream).
    expect(record).not.toHaveProperty("commands");
  });

  test("omits commandRecording when no command rows share the correlationId", () => {
    const record = projectEvent(baseRow({}), 0);
    expect(record.commandRecording).toBeNull();
  });

  test("machine.drift_detected summarises undeclared package/port counts", () => {
    const row = baseRow({
      type: "machine.drift_detected",
      payload: { undeclaredPackages: ["docker", "nginx"], undeclaredPorts: [8080] },
    });
    expect(projectEvent(row).summary).toBe(
      "Drift detected: 2 undeclared package(s), 1 undeclared port(s).",
    );
  });

  test("approval.denied includes the approvers and reason", () => {
    const row = baseRow({
      type: "approval.denied",
      payload: {
        approverIds: ["p-1", "p-2"],
        actionType: "break_glass",
        reason: "no justification given",
      },
    });
    expect(projectEvent(row).summary).toContain("no justification given");
    expect(projectEvent(row).summary).toContain("p-1, p-2");
  });

  test("summarizes at least one representative event from every domain without throwing", () => {
    const samples: ReadonlyArray<[string, unknown]> = [
      ["org.created", { name: "Acme" }],
      ["person.added", { email: "a@acme.test", source: "manual" }],
      ["machine.first_seen", { agentVersion: "1.0.0" }],
      ["access.certificate_revoked", { certificateId: "cert-1", reason: "compromised" }],
      ["approval.expired", { actionType: "offboarding" }],
      ["snapshot.legal_hold_set", { reason: "litigation hold" }],
      ["cloud.resource_deleted", { kind: "disk", resourceId: "disk-1" }],
      ["agent.attestation_failed", { method: "join_token", reason: "expired" }],
    ];

    for (const [type, payload] of samples) {
      const record = projectEvent(baseRow({ type, payload }));
      expect(typeof record.summary).toBe("string");
      expect(record.summary.length).toBeGreaterThan(0);
    }
  });
});

// Note on exhaustiveness: `summarize` in `./projection.ts` is written as a
// switch over `DomainEvent["type"]` with `assertNever` in its default case,
// so an event type added to `@cloudable/events` without a matching summary
// case fails `bun run typecheck` in this package, not a runtime test here.
