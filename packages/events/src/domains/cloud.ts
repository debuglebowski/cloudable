import type { EventEnvelope } from "../envelope";

/**
 * Cloud events: OIDC federation to the customer's Azure subscription and
 * the cloud resources Cloudable creates/deletes on the customer's behalf.
 *
 * No cloud credential is ever stored — federation only, never client
 * secrets.
 */
export type CloudEvent =
  | (EventEnvelope & {
      type: "cloud.credential_federated";
      payload: { subject: string; subscriptionId: string };
    })
  | (EventEnvelope & {
      type: "cloud.credential_rejected";
      payload: { subject: string; reason: string };
    })
  | (EventEnvelope & {
      type: "cloud.resource_created";
      payload: { kind: string; resourceId: string };
    })
  | (EventEnvelope & {
      type: "cloud.resource_deleted";
      payload: { kind: string; resourceId: string };
    });
