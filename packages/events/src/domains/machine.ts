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
      type: "machine.agent_update";
      payload: {
        releaseId: string;
        oldVersion: string;
        newVersion: string;
        status: "attempted" | "succeeded" | "failed" | "rolled_back";
        installedVersion: string;
        desiredVersion: string | null;
        detail: string | null;
      };
    })
  | (EventEnvelope & {
      type: "machine.created";
      payload: {
        name: string;
        provider: "azure" | "docker" | "fake";
        region: string | null;
        size: string;
        image: string;
        /** The profile it was created on. Absent on machines created before profiles existed. */
        profileId?: string | null;
      };
    })
  | (EventEnvelope & {
      type: "machine.resized";
      /** The machine runs on a new size, after its `machine_resize` approval. */
      payload: { fromSize: string; toSize: string; approvalId: string };
    })
  | (EventEnvelope & {
      type: "machine.resize_failed";
      /** The approved resize did not happen. The machine keeps its old size. */
      payload: { fromSize: string; toSize: string; approvalId: string; reason: string };
    })
  | (EventEnvelope & {
      type: "machine.apt_repository_configured";
      /** The agent reported the approved repository in place on the machine. */
      payload: { repositoryId: string };
    })
  | (EventEnvelope & {
      type: "machine.apt_repository_removed";
      /** The agent reported the repository gone from the machine. */
      payload: { repositoryId: string };
    })
  | (EventEnvelope & {
      type: "machine.profile_assigned";
      /** An admin moved the machine to another profile, or off one (`profileId: null`). */
      payload: { profileId: string | null; previousProfileId: string | null };
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
      type: "machine.stop_failed";
      /** A person asked to stop the machine and the provider refused. The machine keeps running. */
      payload: { reason: string };
    })
  | (EventEnvelope & {
      type: "machine.start_failed";
      /** A person asked to start a stopped machine and the provider refused. It stays stopped. */
      payload: { reason: string };
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
      payload: {
        undeclaredPackages: string[];
        undeclaredPorts: number[];
        /** Apt source URIs on the machine that neither Ubuntu nor the org's approved list explains. */
        undeclaredAptSources?: string[];
      };
    })
  | (EventEnvelope & {
      type: "machine.drift_resolved";
      // `approvalId` is nullable: unit 6's event-derivation engine can
      // detect drift clearing (undeclared packages no longer reported)
      // without any approval flow to attribute it to yet. Unit 1/8 will
      // wire the real approval trigger through and this stays non-null
      // once that lands.
      payload: {
        removed: string[];
        approvalId: string | null;
        /** Apt source URIs that were undeclared and no longer are. */
        removedAptSources?: string[];
      };
    })
  | (EventEnvelope & {
      // Emitted only when something changed.
      type: "machine.reconciled";
      payload: { changes: Record<string, unknown> };
    })
  | (EventEnvelope & {
      /**
       * A package install or removal was queued for a machine. A person asked
       * for it, or a package's *Ensure* setting required it.
       *
       * The first family of events in this catalogue that records the control
       * plane asking a machine to change itself. `actorType` is "person" when a
       * person asked. It is "system" when an *Ensure* setting caused it, and
       * `trigger` then names the setting. Nothing else enqueues one of these,
       * which is what keeps invariant 4 true.
       */
      type: "machine.package_action_requested";
      payload: {
        actionId: string;
        packageName: string;
        op: "install" | "uninstall";
        versionPin: string | null;
        /**
         * Why the action exists. Absent on events recorded before ensure settings
         * existed, which were all asked for by a person. For `ensure_installed` /
         * `ensure_latest` the actor is `system`, and the setting's own approval
         * and `setting_changed` event name the people behind it.
         */
        trigger?: "person" | "ensure_installed" | "ensure_latest";
        /** For an ensure action: `missing`, or `outdated` with the versions it moves between. */
        ensureReason?: "missing" | "outdated" | "pin_mismatch";
        fromVersion?: string | null;
        toVersion?: string | null;
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
    })
  | (EventEnvelope & {
      /**
       * A vulnerability scan finished and its findings were stored.
       *
       * Derived by the control plane from what the agent reported (invariant 12),
       * never submitted by the agent. Carries counts, not the findings: the findings
       * are current state in `machine_vulnerabilities`. `newCriticalAndHigh` names
       * the Critical and High CVE ids that appeared since the last scan, capped at 100,
       * so the event alone answers "when did we first see this one".
       */
      type: "machine.vulnerability_scan_completed";
      payload: {
        scanId: string;
        scanner: string;
        scannerVersion: string;
        /** When the vulnerability database the scan ran against was built. Null when unknown. */
        dbBuiltAt: string | null;
        counts: { critical: number; high: number; medium: number; low: number; unknown: number };
        newFindings: number;
        resolvedFindings: number;
        /** True when the machine had more findings than the report cap and the rest were dropped. */
        truncated: boolean;
        newCriticalAndHigh: string[];
      };
    })
  | (EventEnvelope & {
      /**
       * A scan started and did not produce findings. `reason` is one of the agent's
       * fixed failure reasons (for example `db_unavailable`), never free text from the
       * machine, so a failure can be grouped and counted.
       */
      type: "machine.vulnerability_scan_failed";
      payload: {
        scanId: string;
        scanner: string;
        scannerVersion: string | null;
        reason: string;
      };
    })
  | (EventEnvelope & {
      /**
       * The scanner was put on a machine, or replaced by another version.
       *
       * Part of the closed list of components Cloudable installs itself (see
       * `docs/agents.md`). An admin asked for it by turning scanning on for the org;
       * this records what that did on this machine.
       */
      type: "machine.scanner_installed";
      payload: {
        scanner: string;
        version: string;
        previousVersion: string | null;
      };
    });
