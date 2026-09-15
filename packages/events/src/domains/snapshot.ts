import type { EventEnvelope } from "../envelope";

/**
 * Snapshot events: created at archive/upgrade/manual triggers, restored
 * under approval, expired per retention, and legal hold.
 */
export type SnapshotEvent =
  | (EventEnvelope & {
      type: "snapshot.created";
      payload: {
        trigger: "archive" | "upgrade" | "manual";
        region: string | null;
        /** The real total the provider reported. Rows and events written before
         * snapshots became real carry a hardcoded 32 GiB placeholder instead. */
        sizeBytes: number;
        /**
         * Which disks were captured: "full" is the OS disk and the persistent disk,
         * "shallow" is the persistent disk only.
         *
         * Additive field, so invariant 11 (event type names are a public interface,
         * additive only) holds — the name is untouched. Not the same vocabulary as
         * `snapshot.restored`'s `mode`, which is what a RESTORE writes back; this is
         * what the snapshot CAPTURED.
         */
        scope: "full" | "shallow";
      };
    })
  | (EventEnvelope & {
      type: "snapshot.restored";
      payload: {
        mode: "data" | "config" | "full";
        targetMachineId: string;
        approvalId: string;
      };
    })
  | (EventEnvelope & {
      type: "snapshot.expired";
      payload: { createdAt: string; retentionDays: number };
    })
  | (EventEnvelope & {
      type: "snapshot.legal_hold_set";
      payload: { reason: string };
    })
  | (EventEnvelope & {
      type: "snapshot.legal_hold_cleared";
      payload: { reason: string };
    });
