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
      /**
       * A person asked for a package to be installed or removed on a machine.
       *
       * The first family of events in this catalogue that records the control
       * plane asking a machine to change itself. `actorType` is always
       * "person": nothing enqueues one of these on its own, which is what
       * keeps "nothing installs or removes software unasked" true.
       */
      type: "machine.package_action_requested";
      payload: {
        actionId: string;
        packageName: string;
        op: "install" | "uninstall";
        versionPin: string | null;
      };
    })
  | (EventEnvelope & {
      type: "machine.package_action_completed";
      payload: {
        actionId: string;
        packageName: string;
        op: "install" | "uninstall";
        installedVersion: string | null;
      };
    })
  | (EventEnvelope & {
      /**
       * `reason` covers both a package manager that refused and an action the
       * agent collected and never reported back on (`expired`), which are
       * different failures worth telling apart in an audit.
       */
      type: "machine.package_action_failed";
      payload: {
        actionId: string;
        packageName: string;
        op: "install" | "uninstall";
        reason: string;
        expired: boolean;
      };
    })
  | (EventEnvelope & {
      // Additive extension, consistent with the rest of
      // the machine domain — additive only.
      type: "machine.first_seen";
      payload: { agentVersion: string };
    });
