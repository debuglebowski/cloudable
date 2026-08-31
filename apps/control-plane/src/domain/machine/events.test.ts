import { describe, expect, test } from "bun:test";
import { deriveEvents } from "./events";
import type { MachineLastKnownState, MachineReportedState } from "./types";

const ctx = {
  orgId: "org-1",
  machineId: "machine-1",
  correlationId: "corr-1",
  occurredAt: new Date("2026-01-01T00:00:00Z"),
};

const baseline: MachineLastKnownState = {
  state: "running",
  packagesHash: "hash-a",
  undeclaredPackages: [],
  externalResourceId: "azure-vm-1",
  runningAccessMethods: [],
};

const reportedFromBaseline = (
  overrides: Partial<MachineReportedState> = {},
): MachineReportedState => ({
  state: baseline.state,
  packagesHash: baseline.packagesHash,
  undeclaredPackages: baseline.undeclaredPackages,
  externalResourceId: baseline.externalResourceId,
  runningAccessMethods: baseline.runningAccessMethods,
  agentVersion: "1.0.0",
  ...overrides,
});

describe("deriveEvents", () => {
  test("no previous state -> first_seen only, regardless of what's reported", () => {
    const reported = reportedFromBaseline({ undeclaredPackages: ["curl"], state: "error" });

    const events = deriveEvents(undefined, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "machine.first_seen",
      payload: { agentVersion: "1.0.0" },
      orgId: ctx.orgId,
      machineId: ctx.machineId,
      correlationId: ctx.correlationId,
      occurredAt: ctx.occurredAt,
      actorType: "agent",
      actorId: ctx.machineId,
      schemaVersion: 1,
    });
  });

  test("identical reported vs previous -> zero events (no-op reconcile is not an event)", () => {
    const events = deriveEvents(baseline, reportedFromBaseline(), ctx);
    expect(events).toEqual([]);
  });

  test("state changed -> state_reported with a changes payload, no drift events", () => {
    const reported = reportedFromBaseline({ state: "stopped" });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "machine.state_reported",
      payload: { changes: { state: { from: "running", to: "stopped" } } },
    });
  });

  test("packagesHash changed -> state_reported with a changes payload", () => {
    const reported = reportedFromBaseline({ packagesHash: "hash-b" });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "machine.state_reported",
      payload: { changes: { packagesHash: { from: "hash-a", to: "hash-b" } } },
    });
  });

  test("externalResourceId changed -> state_reported with a changes payload", () => {
    const reported = reportedFromBaseline({ externalResourceId: "azure-vm-2" });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "machine.state_reported",
      payload: {
        changes: { externalResourceId: { from: "azure-vm-1", to: "azure-vm-2" } },
      },
    });
  });

  test("runningAccessMethods changed -> state_reported with a changes payload", () => {
    const reported = reportedFromBaseline({ runningAccessMethods: ["web_terminal"] });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "machine.state_reported",
      payload: {
        changes: { runningAccessMethods: { from: [], to: ["web_terminal"] } },
      },
    });
  });

  test("runningAccessMethods unchanged (even if reordered) -> zero events", () => {
    const withMethods: MachineLastKnownState = {
      ...baseline,
      runningAccessMethods: ["web_terminal", "ssh"],
    };
    const reported = reportedFromBaseline({ runningAccessMethods: ["ssh", "web_terminal"] });

    const events = deriveEvents(withMethods, reported, ctx);

    expect(events).toEqual([]);
  });

  test("multiple fields changed -> a single state_reported with all changes", () => {
    const reported = reportedFromBaseline({ state: "error", packagesHash: "hash-c" });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      changes: {
        state: { from: "running", to: "error" },
        packagesHash: { from: "hash-a", to: "hash-c" },
      },
    });
  });

  test("new drift appearing -> state_reported AND drift_detected", () => {
    const reported = reportedFromBaseline({ undeclaredPackages: ["nginx"] });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "machine.state_reported",
        payload: { changes: { undeclaredPackages: { from: [], to: ["nginx"] } } },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "machine.drift_detected",
        payload: { undeclaredPackages: ["nginx"], undeclaredPorts: [] },
      }),
    );
  });

  test("drift set unchanged (even if reordered) -> zero events", () => {
    const drifted: MachineLastKnownState = { ...baseline, undeclaredPackages: ["curl", "nginx"] };
    const reported = reportedFromBaseline({ undeclaredPackages: ["nginx", "curl"] });

    const events = deriveEvents(drifted, reported, ctx);

    expect(events).toEqual([]);
  });

  test("drift set changes while still non-empty -> state_reported AND a fresh drift_detected", () => {
    const drifted: MachineLastKnownState = { ...baseline, undeclaredPackages: ["curl"] };
    const reported = reportedFromBaseline({ undeclaredPackages: ["curl", "nginx"] });

    const events = deriveEvents(drifted, reported, ctx);

    expect(events).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "machine.drift_detected",
        payload: { undeclaredPackages: ["curl", "nginx"], undeclaredPorts: [] },
      }),
    );
    const stateReported = events.find((event) => event.type === "machine.state_reported");
    expect(stateReported?.payload).toEqual({
      changes: { undeclaredPackages: { from: ["curl"], to: ["curl", "nginx"] } },
    });
  });

  test("drift clears entirely -> state_reported AND drift_resolved with approvalId null", () => {
    const drifted: MachineLastKnownState = { ...baseline, undeclaredPackages: ["curl", "nginx"] };
    const reported = reportedFromBaseline({ undeclaredPackages: [] });

    const events = deriveEvents(drifted, reported, ctx);

    expect(events).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "machine.drift_resolved",
        payload: { removed: ["curl", "nginx"], approvalId: null },
      }),
    );
    const stateReported = events.find((event) => event.type === "machine.state_reported");
    expect(stateReported?.payload).toEqual({
      changes: { undeclaredPackages: { from: ["curl", "nginx"], to: [] } },
    });
  });

  test("no previous drift, no reported drift -> no drift events even if other fields changed", () => {
    const reported = reportedFromBaseline({ state: "stopped" });

    const events = deriveEvents(baseline, reported, ctx);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("machine.state_reported");
  });

  test("every returned event carries the full envelope from ctx", () => {
    const reported = reportedFromBaseline({ state: "stopped" });
    const events = deriveEvents(baseline, reported, ctx);

    for (const event of events) {
      expect(event.orgId).toBe(ctx.orgId);
      expect(event.machineId).toBe(ctx.machineId);
      expect(event.correlationId).toBe(ctx.correlationId);
      expect(event.occurredAt).toBe(ctx.occurredAt);
      expect(event.actorType).toBe("agent");
      expect(event.actorId).toBe(ctx.machineId);
      expect(event.schemaVersion).toBe(1);
    }
  });
});
