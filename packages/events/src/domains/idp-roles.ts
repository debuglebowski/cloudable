import type { EventEnvelope } from "../envelope";

/**
 * Roles from the identity provider. The names and payload fields are the shared IdP role
 * contract's audit events (`@normain/idp-role-contract`), word for word, so the same decision
 * reads the same in Cloudable, Kahuna and SlayZone. Grants are sorted lists of Cloudable targets
 * (`owner`, `admin`, `member`, `approver`); `actor` and `subject` are opaque ids, `reason` a
 * fixed code. Nothing secret is ever in them.
 */
export interface IdpRolesAuditPayload {
  service: string;
  actor: string;
  subject: string;
  source: "oidc" | "saml" | "local" | "activation";
  previousGrants: string[];
  newGrants: string[];
  reason: string;
}

export type IdpRolesEvent = EventEnvelope & {
  type:
    | "idp_roles.granted"
    | "idp_roles.denied"
    | "idp_roles.revalidated"
    | "idp_roles.local_change_refused"
    | "idp_roles.activation";
  payload: IdpRolesAuditPayload;
};
