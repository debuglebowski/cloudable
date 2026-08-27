import type { EventEnvelope } from "../envelope";

/**
 * Machine events: the full lifecycle of a Cloudable machine, from creation
 * through provisioning, ownership, state reporting, drift, reconciliation,
 * offboarding, and archival.
 *
 * Reconcile only closes gaps — it removes undeclared software, never
 * installs (invariant 4). Drift is flagged, never auto-corrected
 * (invariant 5). Machines are archived, never deleted (invariant 6).
 */
export type MachineEvent =
  | (EventEnvelope & {
      type: "machine.created";
      payload: { name: string; region: string; size: string; image: string };
    })
  | (EventEnvelope & {
      type: "machine.provisioned";
      payload: { cloudResourceId: string };
    })
  | (EventEnvelope & {
      type: "machine.provisioning_failed";
      payload: { error: string; stage: string };
    })
  | (EventEnvelope & {
      type: "machine.owner_assigned";
      payload: { personId: string; previousPersonId: string | null };
    })
  | (EventEnvelope & {
      type: "machine.owner_cleared";
      payload: { previousPersonId: string };
    })
  | (EventEnvelope & {
      type: "machine.started";
      payload: Record<string, never>;
    })
  | (EventEnvelope & {
      type: "machine.stopped";
      payload: { initiator: "user" | "policy" | "offboarding" };
    })
  | (EventEnvelope & {
      type: "machine.reimaged";
      payload: { previousImage: string; currentImage: string };
    })
  | (EventEnvelope & {
      type: "machine.setting_changed";
      payload: {
        key: string;
        previous: unknown;
        current: unknown;
        overridesLevel: string;
      };
    })
  | (EventEnvelope & {
      type: "machine.offboarded";
      payload: { previousOwnerId: string; approvalId: string };
    })
  | (EventEnvelope & {
      type: "machine.archived";
      payload: { snapshotId: string; retentionExpiresAt: string };
    })
  | (EventEnvelope & {
      // Emitted only when state actually changed.
      type: "machine.state_reported";
      payload: { changes: Record<string, unknown> };
    })
  | (EventEnvelope & {
      type: "machine.drift_detected";
      payload: { undeclaredPackages: string[]; undeclaredPorts: number[] };
    })
  | (EventEnvelope & {
      type: "machine.drift_resolved";
      payload: { removed: string[]; approvalId: string };
    })
  | (EventEnvelope & {
      // Emitted only when something changed.
      type: "machine.reconciled";
      payload: { changes: Record<string, unknown> };
    })
  | (EventEnvelope & {
      // Additive extension: not in the original spec table, but needed by
      // the event-derivation-engine unit and consistent with the rest of
      // the machine domain (invariant 11 — additive only).
      type: "machine.first_seen";
      payload: { agentVersion: string };
    });
