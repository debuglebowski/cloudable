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
        sizeBytes: number;
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
