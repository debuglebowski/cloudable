/**
 * The one place Cloudable imports the shared IdP role contract (`@normain/idp-role-contract`,
 * pinned to a vendored, hash-checked tarball). Config parsing, claim extraction, role mapping,
 * the freshness decision, the audit event shape and the refusal constants all come from it, so
 * Cloudable, Kahuna and SlayZone decide the same things the same way. What stays here is
 * Cloudable's own: its role precedence, SAML, storage, revocation and enforcement.
 */
export {
  IdpRoleError,
  ROLES_MANAGED_BY_IDP,
  ROLES_MANAGED_HTTP_STATUS,
  ROLES_MANAGED_MESSAGE,
  buildAuditEvent,
  freshness,
  parseConfig,
  resolveGrants,
} from "@normain/idp-role-contract";
export type { AuditEvent, AuditEventName, RoleConfig } from "@normain/idp-role-contract";

/** What an `IDP_ROLE_MAPPING` value may name. `approver` is the flag on top of a role. */
export const CLOUDABLE_TARGETS = ["owner", "admin", "member", "approver"] as const;

/** `service` in every audit event Cloudable writes. */
export const SERVICE = "cloudable";
