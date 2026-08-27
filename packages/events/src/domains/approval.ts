import type { EventEnvelope } from "../envelope";

/**
 * Approval events: dual-control and single-approver workflows that gate
 * sensitive actions (elevation, drift resolution, offboarding, restore).
 */
export type ApprovalEvent =
  | (EventEnvelope & {
      type: "approval.requested";
      payload: {
        actionType: string;
        actionRef: string;
        reason: string;
        mode: "none" | "single" | "dual";
      };
    })
  | (EventEnvelope & {
      type: "approval.granted";
      payload: { approverIds: string[]; actionType: string };
    })
  | (EventEnvelope & {
      type: "approval.denied";
      payload: { approverIds: string[]; actionType: string; reason: string };
    })
  | (EventEnvelope & {
      type: "approval.expired";
      payload: { actionType: string };
    });
