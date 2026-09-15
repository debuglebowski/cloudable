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

describe("evidence projection", () => {
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
    // Non-cloud event: the `extensions` key is left out entirely, not
    // present-with-`undefined` (see the `exactOptionalPropertyTypes` note
    // in `./projection.ts`).
    expect(record).not.toHaveProperty("extensions");
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
    // command rows themselves — never merged into the stream.
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

  test("extensions carries cloud-specific detail for cloud.* event types", () => {
    const federated = projectEvent(
      baseRow({
        type: "cloud.credential_federated",
        payload: { subject: "repo:acme/infra:ref:refs/heads/main", subscriptionId: "sub-123" },
      }),
    );
    expect(federated.extensions).toEqual({
      cloud: { subscriptionId: "sub-123", subject: "repo:acme/infra:ref:refs/heads/main" },
    });

    const rejected = projectEvent(
      baseRow({
        type: "cloud.credential_rejected",
        payload: { subject: "repo:acme/infra:ref:refs/heads/main", reason: "subject mismatch" },
      }),
    );
    expect(rejected.extensions).toEqual({
      cloud: { subject: "repo:acme/infra:ref:refs/heads/main", reason: "subject mismatch" },
    });

    const created = projectEvent(
      baseRow({
        type: "cloud.resource_created",
        payload: { kind: "virtual_machine", resourceId: "vm-1" },
      }),
    );
    expect(created.extensions).toEqual({ cloud: { resourceId: "vm-1", kind: "virtual_machine" } });

    const deleted = projectEvent(
      baseRow({
        type: "cloud.resource_deleted",
        payload: { kind: "disk", resourceId: "disk-1" },
      }),
    );
    expect(deleted.extensions).toEqual({ cloud: { resourceId: "disk-1", kind: "disk" } });
  });

  test("extensions is absent for non-cloud event types", () => {
    const machineEvent = projectEvent(
      baseRow({
        type: "machine.started",
        payload: {},
      }),
    );
    expect(machineEvent.extensions).toBeUndefined();

    const approvalEvent = projectEvent(
      baseRow({
        type: "approval.expired",
        payload: { actionType: "offboarding" },
      }),
    );
    expect(approvalEvent.extensions).toBeUndefined();
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

// Note on exhaustiveness: `summarize` and `extensionsFor` in `./projection.ts`
// are each written as a switch over `DomainEvent["type"]` with `assertNever`
// in their default case, so an event type added to `@cloudable/events`
// without a matching case in either fails `bun run typecheck` in this
// package, not a runtime test here.

describe("package manifest summaries", () => {
  test("a machine-scope package edit names the package and both values", () => {
    const row = baseRow({
      type: "machine.setting_changed",
      machineId: "machine-1",
      payload: {
        key: "package:docker",
        previous: { versionPin: null, pinned: false, excluded: false },
        current: { versionPin: "24", pinned: false, excluded: false },
        overridesLevel: "org",
      },
    });

    // The values are the whole answer for an auditor: "docker was changed"
    // says nothing, "any version -> 24" says what happened.
    expect(projectEvent(row).summary).toBe('Package "docker" at machine scope: any version -> 24.');
  });

  test("an exclusion reads as an exclusion, not as a missing version", () => {
    const row = baseRow({
      type: "machine.setting_changed",
      machineId: "machine-1",
      payload: {
        key: "package:docker",
        previous: { versionPin: "24", pinned: false, excluded: false },
        current: { versionPin: "24", pinned: false, excluded: true },
        overridesLevel: "org",
      },
    });

    expect(projectEvent(row).summary).toBe('Package "docker" at machine scope: 24 -> excluded.');
  });

  test("adding and removing read as the two ends of nothing", () => {
    const added = baseRow({
      type: "org.setting_changed",
      payload: {
        key: "package:ripgrep",
        previous: null,
        current: { packageName: "ripgrep", versionPin: null, pinned: true },
        level: "org",
      },
    });
    const removed = baseRow({
      type: "org.setting_changed",
      payload: {
        key: "package:ripgrep",
        previous: { packageName: "ripgrep", versionPin: null, pinned: true },
        current: null,
        level: "org",
      },
    });

    expect(projectEvent(added).summary).toBe(
      'Package "ripgrep" at org scope: not declared -> any version, pinned.',
    );
    expect(projectEvent(removed).summary).toBe(
      'Package "ripgrep" at org scope: any version, pinned -> not declared.',
    );
  });

  test("a setting that is not a package keeps its own summary", () => {
    const row = baseRow({
      type: "machine.setting_changed",
      machineId: "machine-1",
      payload: { key: "logging_tier", previous: 2, current: 1, overridesLevel: "org" },
    });

    expect(projectEvent(row).summary).toBe(
      'Machine setting "logging_tier" was changed, overriding the org default.',
    );
  });
});
