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
    });
