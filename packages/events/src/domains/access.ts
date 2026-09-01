import type { EventEnvelope } from "../envelope";

/**
 * Access events: certificates, sessions, and time-boxed elevation.
 *
 * NOTE: `access.command_recorded` is intentionally NOT part of this
 * catalogue. Per spec it lives in a separate high-volume store — the
 * `accessCommandRecorded` table in `@cloudable/schema` — and is referenced
 * by correlationId rather than being modeled as an append-only event here.
 */
export type AccessEvent =
  | (EventEnvelope & {
      type: "access.certificate_issued";
      payload: { principal: string; expiresAt: string; machineScope: string };
    })
  | (EventEnvelope & {
      type: "access.certificate_revoked";
      payload: { certificateId: string; reason: string };
    })
  | (EventEnvelope & {
      type: "access.session_started";
      payload: { method: "terminal" | "ssh"; osUser: string };
    })
  | (EventEnvelope & {
      type: "access.session_ended";
      // `reason` is optional (additive — invariant #11) rather than a new payload shape: a
      // pre-existing consumer that hasn't read this field yet still parses the event fine.
      // `person_ended` | `policy_terminated` | `connection_lost` (see `sessions.terminationReason`).
      payload: { durationSeconds: number; reason?: string };
    })
  | (EventEnvelope & {
      type: "access.session_denied";
      payload: { reason: string; method: "terminal" | "ssh" };
    })
  | (EventEnvelope & {
      type: "access.elevation_requested";
      payload: {
        level: "file_recovery" | "shell";
        reason: string;
        approvalId: string;
      };
    })
  | (EventEnvelope & {
      type: "access.elevation_granted";
      payload: {
        level: "file_recovery" | "shell";
        expiresAt: string;
        approvalId: string;
      };
    })
  | (EventEnvelope & {
      type: "access.elevation_expired";
      payload: { level: "file_recovery" | "shell" };
    });
