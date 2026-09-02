import type { EventEnvelope } from "../envelope";

/**
 * Person events: a machine has exactly one owner, always a person.
 * These events track person lifecycle and role changes.
 */
export type PersonEvent =
  | (EventEnvelope & {
      type: "person.added";
      payload: { email: string; source: "manual" | "scim" };
    })
  | (EventEnvelope & {
      type: "person.activated";
      payload: Record<string, never>;
    })
  | (EventEnvelope & {
      type: "person.deactivated";
      payload: { source: "manual" | "scim" };
    })
  | (EventEnvelope & {
      type: "person.role_changed";
      payload: { previous: string; current: string };
    });
