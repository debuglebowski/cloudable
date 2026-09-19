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
        /** The machine that ended up with the data — for a new-machine restore, the
         * machine that was just created for it, never the one the snapshot came from. */
        targetMachineId: string;
        approvalId: string;
        /** Whether this restore provisioned a machine or overwrote one that existed.
         * "Put back onto their machine" and "built them a new one" are different events
         * to anyone reading the record, and the target id alone does not say which. */
        createdNewMachine?: boolean;
      };
    })
  | (EventEnvelope & {
      /**
       * A snapshot passed its retention window: its captured disks were destroyed at the
       * provider and the row was marked expired.
       *
       * This is check #5's evidence that hard-deletion happened on schedule, so the sweep
       * writes it only AFTER the provider deletes succeeded — it used to be written over
       * a deletion that never happened at all.
       */
      type: "snapshot.expired";
      payload: {
        createdAt: string;
        retentionDays: number;
        /**
         * The disk ids actually destroyed, so the evidence names what was deleted rather
         * than asserting that something was.
         *
         * Empty means nothing was destroyed because nothing was recorded to destroy — a
         * row written before snapshots captured real ids. Empty NEVER means a delete was
         * skipped or failed: a snapshot whose disks could not all be destroyed is not
         * expired and gets no event.
         */
        deletedDiskExternalIds: string[];
      };
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
