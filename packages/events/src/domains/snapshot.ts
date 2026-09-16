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
      /**
       * A disk this snapshot recorded no longer exists at the provider, found while its
       * retention window was still open.
       *
       * Deliberately NOT `snapshot.expired`. Expiry means the data was deleted on
       * schedule and is evidence that retention worked; this means it went away early
       * and nothing recorded why. Reporting one as the other would turn a retention
       * failure into proof of a retention success.
       */
      type: "snapshot.data_missing";
      payload: {
        /** The recorded ids that could not be found. */
        missingDiskExternalIds: string[];
        /** How many disks the row recorded in total, so "1 of 2" is distinguishable
         * from "all of them". */
        recordedDiskCount: number;
        /** Still in the future when this was found — that is what makes it early. */
        expiresAt: string;
      };
    })
  | (EventEnvelope & {
      type: "snapshot.legal_hold_set";
      payload: { reason: string };
    })
  | (EventEnvelope & {
      type: "snapshot.legal_hold_cleared";
      payload: { reason: string };
    });
