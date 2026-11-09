import type { EventEnvelope } from "../envelope";

/**
 * Person events: a machine has exactly one owner, always a person.
 * These events track person lifecycle and role changes.
 */
export type PersonEvent =
  | (EventEnvelope & {
      type: "person.added";
      payload: {
        email: string;
        source: "manual" | "scim";
        /** Optional for compatibility with previously recorded events. */
        personId?: string;
        role?: string;
        approver?: boolean;
      };
    })
  | (EventEnvelope & {
      type: "person.activated";
      payload: { personId?: string; role?: string; approver?: boolean };
    })
  | (EventEnvelope & {
      type: "person.deactivated";
      payload: { source: "manual" | "scim" };
    })
  | (EventEnvelope & {
      type: "person.role_changed";
      payload: { previous: string; current: string; personId?: string };
    })
  | (EventEnvelope & {
      type: "person.email_changed";
      /** Every console session and CLI token the person held is revoked in the same change. */
      payload: { previous: string; current: string };
    })
  | (EventEnvelope & {
      type: "person.approver_changed";
      payload: { previous: boolean; current: boolean; personId?: string };
    });
