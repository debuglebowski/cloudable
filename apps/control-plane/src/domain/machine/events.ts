import type { DomainEvent } from "@cloudable/events";
import type { MachineLastKnownState, MachineReportedState } from "./types";

export interface DeriveEventsContext {
  orgId: string;
  machineId: string;
  correlationId: string;
  occurredAt: Date;
}

/** Order-independent equality for the two undeclared-package lists. */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Diffs `previous` (the control plane's last-known state for a machine)
 * against `reported` (what the agent just reported) and returns the
 * `MachineEvent`s that fact warrants — the server-side "diff-and-emit"
 * pattern from spec §23 ("the control plane derives events; the agent does
 * not submit them", CLAUDE.md invariant #12).
 *
 * Pure and I/O-free by design: no Effect, no Db, no EventBus. That's
 * deliberate — this is meant to be a drop-in for anywhere that has a
 * before/after machine-state pair, including this unit's own
 * `services/reconcile-diff.ts`, unit 1's reconcile loop, and unit 3's agent
 * `/report` handler.
 *
 * Rules (all required — see this file's colocated test for the full table):
 * - `previous === undefined` (this machine has never reported before):
 *   emit `machine.first_seen` and nothing else, even if `reported` would
 *   otherwise look drifted or degraded. There is no "previous" to diff
 *   against yet.
 * - `machine.state_reported` is emitted with a `changes` payload only when
 *   something in `reported` actually differs from `previous` — never on a
 *   no-op report. Per spec §24 ("What is not an event"): successful no-op
 *   reconciles would otherwise dominate the catalogue.
 * - `machine.drift_detected` is emitted when `reported.undeclaredPackages`
 *   is non-empty AND that set differs from `previous.undeclaredPackages` —
 *   i.e. only on a *change* in the drift set (new drift appearing, or an
 *   already-drifted machine's drift set changing), never on every report
 *   while the same drift persists unchanged.
 * - `machine.drift_resolved` is emitted when `previous.undeclaredPackages`
 *   was non-empty and `reported.undeclaredPackages` is now empty.
 *
 * `id` and `recordedAt` on the returned events are placeholders (empty
 * string / `ctx.occurredAt`), present only to satisfy `DomainEvent`'s type.
 * Per `EventBus.publish`'s doc comment, it assigns the real ULID and
 * `recordedAt` unconditionally on every event it's given, overwriting
 * whatever is here — `deriveEvents` itself never sets them for real.
 */
export function deriveEvents(
  previous: MachineLastKnownState | undefined,
  reported: MachineReportedState,
  ctx: DeriveEventsContext,
): DomainEvent[] {
  const envelope = {
    id: "",
    occurredAt: ctx.occurredAt,
    recordedAt: ctx.occurredAt,
    orgId: ctx.orgId,
    machineId: ctx.machineId,
    correlationId: ctx.correlationId,
    // The agent's machine identity is the actor for every event derived
    // from one of its reports — spec §9's attestation yields "a machine
    // identity", and there's no separate agent-principal concept yet.
    actorType: "agent" as const,
    actorId: ctx.machineId,
  };

  if (previous === undefined) {
    return [
      {
        ...envelope,
        schemaVersion: 1,
        type: "machine.first_seen",
        payload: { agentVersion: reported.agentVersion },
      },
    ];
  }

  const events: DomainEvent[] = [];

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (previous.state !== reported.state) {
    changes.state = { from: previous.state, to: reported.state };
  }
  if (previous.packagesHash !== reported.packagesHash) {
    changes.packagesHash = { from: previous.packagesHash, to: reported.packagesHash };
  }
  if (previous.externalResourceId !== reported.externalResourceId) {
    changes.externalResourceId = {
      from: previous.externalResourceId,
      to: reported.externalResourceId,
    };
  }
  const undeclaredChanged = !sameStringSet(
    previous.undeclaredPackages,
    reported.undeclaredPackages,
  );
  if (undeclaredChanged) {
    changes.undeclaredPackages = {
      from: previous.undeclaredPackages,
      to: reported.undeclaredPackages,
    };
  }

  if (Object.keys(changes).length > 0) {
    events.push({
      ...envelope,
      schemaVersion: 1,
      type: "machine.state_reported",
      payload: { changes },
    });
  }

  const wasDrifted = previous.undeclaredPackages.length > 0;
  const isDrifted = reported.undeclaredPackages.length > 0;

  if (isDrifted && undeclaredChanged) {
    events.push({
      ...envelope,
      schemaVersion: 1,
      type: "machine.drift_detected",
      payload: {
        undeclaredPackages: reported.undeclaredPackages,
        // Port drift isn't modeled by `MachineReportedState` yet (this unit
        // only tracks package drift) — reported empty until a future unit
        // adds it, rather than omitted, since the payload type requires it.
        undeclaredPorts: [],
      },
    });
  } else if (wasDrifted && !isDrifted) {
    events.push({
      ...envelope,
      schemaVersion: 1,
      type: "machine.drift_resolved",
      payload: {
        removed: previous.undeclaredPackages,
        // No approval flow is wired to drift resolution yet — unit 1/8
        // will thread the real approval id through once one exists.
        approvalId: null,
      },
    });
  }

  return events;
}
