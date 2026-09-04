import type { EventEnvelope } from "../envelope";

/**
 * Machine events: the full lifecycle of a Cloudable machine, from creation
 * through provisioning, ownership, state reporting, drift, reconciliation,
 * offboarding, and archival.
 *
 * Reconcile only closes gaps — it removes undeclared software, never
 * installs. Drift is flagged, never auto-corrected.
 * Machines are archived, never deleted.
 */
export type MachineEvent =
  | (EventEnvelope & {
      type: "machine.created";
      payload: {
        name: string;
        provider: "azure" | "docker" | "fake";
        region: string | null;
        size: string;
        image: string;
      };
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
      // `approvalId` is nullable: unit 6's event-derivation engine can
      // detect drift clearing (undeclared packages no longer reported)
      // without any approval flow to attribute it to yet. Unit 1/8 will
      // wire the real approval trigger through and this stays non-null
      // once that lands.
      payload: { removed: string[]; approvalId: string | null };
    })
  | (EventEnvelope & {
      // Emitted only when something changed.
      type: "machine.reconciled";
      payload: { changes: Record<string, unknown> };
    })
  | (EventEnvelope & {
      // Additive extension, consistent with the rest of
      // the machine domain — additive only.
      type: "machine.first_seen";
      payload: { agentVersion: string };
    });
