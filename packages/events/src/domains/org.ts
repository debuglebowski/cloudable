import type { EventEnvelope } from "../envelope";

/**
 * Org-level events: org lifecycle and org-scoped integrations (IdP, cloud,
 * secret store).
 */
export type OrgEvent =
  | (EventEnvelope & {
      type: "org.created";
      payload: { name: string };
    })
  | (EventEnvelope & {
      type: "org.setting_changed";
      payload: {
        key: string;
        previous: unknown;
        current: unknown;
        level: "org" | "machine";
      };
    })
  | (EventEnvelope & {
      type: "org.integration_connected";
      payload: { kind: "idp" | "cloud" | "secret_store"; identifier: string };
    })
  | (EventEnvelope & {
      type: "org.integration_removed";
      payload: { kind: "idp" | "cloud" | "secret_store"; identifier: string };
    })
  | (EventEnvelope & {
      type: "org.events_expired";
      /**
       * Written by the retention sweep each time it deletes events for an org. The
       * only trace a deletion leaves, so it carries counts and the cutoff only —
       * never anything copied from the events it removed.
       */
      payload: {
        /** Events older than this (ISO 8601) were eligible. */
        cutoff: string;
        /** The org's retention window, in days, when the sweep ran. */
        retentionDays: number;
        deletedCount: number;
      };
    });
