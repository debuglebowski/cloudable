import type { DomainEvent } from "./catalogue";

/**
 * Per-event metadata: the minimum logging tier at which an event is
 * emitted, plus a one-sentence human description.
 *
 * `tier` is the MINIMUM logging tier at which this event is emitted:
 *   - tier 1: always emitted regardless of config — the compliance floor.
 *   - tier 2: routine/high-frequency operational events, emitted at
 *     standard logging levels.
 *
 * There is no tier-3 event in this catalogue: `access.command_recorded`
 * (the tier-3, highest-volume shell recording) is deliberately excluded
 * from this catalogue — see the comment in `domains/access.ts`.
 *
 * Because this is a `Record` keyed by `DomainEvent["type"]`, the compiler
 * enforces completeness: adding a new event type without an entry here is
 * a type error.
 */
export const EVENT_METADATA: Record<
  DomainEvent["type"],
  { tier: 1 | 2 | 3; description: string }
> = {
  // --- org --- (tier 1: org lifecycle and integrations are always audited)
  "org.created": { tier: 1, description: "A new org was created." },
  "org.setting_changed": {
    tier: 1,
    description: "An org- or machine-level default setting was changed.",
  },
  "org.integration_connected": {
    tier: 1,
    description: "An IdP, cloud, or secret store integration was connected to the org.",
  },
  "org.integration_removed": {
    tier: 1,
    description: "An IdP, cloud, or secret store integration was removed from the org.",
  },

  // --- person --- (tier 1: identity and access lifecycle is always audited)
  "person.added": {
    tier: 1,
    description: "A person was added to the org, manually or via SCIM.",
  },
  "person.activated": {
    tier: 1,
    description: "A person's account was activated.",
  },
  "person.deactivated": {
    tier: 1,
    description: "A person's account was deactivated, manually or via SCIM.",
  },
  "person.role_changed": {
    tier: 1,
    description: "A person's role was changed.",
  },

  // --- machine --- (tier 1 by default; setting_changed/state_reported/
  // reconciled are tier 2, routine operational updates)
  "machine.created": {
    tier: 1,
    description: "A machine was declared with a name, region, size, and image.",
  },
  "machine.provisioned": {
    tier: 1,
    description: "A machine finished provisioning and has a cloud resource.",
  },
  "machine.provisioning_failed": {
    tier: 1,
    description: "A machine failed to provision at a given stage.",
  },
  "machine.owner_assigned": {
    tier: 1,
    description: "A machine was assigned to a person owner.",
  },
  "machine.owner_cleared": {
    tier: 1,
    description: "A machine's owner was cleared.",
  },
  "machine.started": { tier: 1, description: "A machine was started." },
  "machine.stopped": {
    tier: 1,
    description: "A machine was stopped by a user, policy, or offboarding.",
  },
  "machine.reimaged": {
    tier: 1,
    description: "A machine's image was replaced with a different image.",
  },
  "machine.setting_changed": {
    tier: 2,
    description: "A machine-level setting was changed, overriding a template or org default.",
  },
  "machine.offboarded": {
    tier: 1,
    description: "A machine was offboarded from its previous owner under approval.",
  },
  "machine.archived": {
    tier: 1,
    description: "A machine was archived with a final snapshot and retention window.",
  },
  "machine.state_reported": {
    tier: 2,
    description: "The agent reported observed machine state that changed since the last report.",
  },
  "machine.drift_detected": {
    tier: 1,
    description: "Undeclared packages or open ports were detected on a machine.",
  },
  "machine.drift_resolved": {
    tier: 1,
    description: "Detected drift was removed from a machine under approval.",
  },
  "machine.reconciled": {
    tier: 2,
    description: "Reconciliation removed undeclared software or settings to close a gap with desired state.",
  },
  "machine.first_seen": {
    tier: 1,
    description: "The control agent contacted the control plane for the first time on a machine.",
  },

  // --- access --- (certificates, denials, and elevation are always
  // audited at tier 1; routine session start/end is tier 2)
  "access.certificate_issued": {
    tier: 1,
    description: "A short-lived SSH certificate was issued for a principal.",
  },
  "access.certificate_revoked": {
    tier: 1,
    description: "An SSH certificate was revoked before its expiry.",
  },
  "access.session_started": {
    tier: 2,
    description: "A terminal or SSH session started on a machine.",
  },
  "access.session_ended": {
    tier: 2,
    description: "A terminal or SSH session ended after a given duration.",
  },
  "access.session_denied": {
    tier: 1,
    description: "A terminal or SSH session was denied access to a machine.",
  },
  "access.elevation_requested": {
    tier: 1,
    description: "A person requested elevated access (file recovery or shell) with a reason.",
  },
  "access.elevation_granted": {
    tier: 1,
    description: "Elevated access was granted for a limited time.",
  },
  "access.elevation_expired": {
    tier: 1,
    description: "A granted elevation expired.",
  },

  // --- approval --- (tier 1: approvals gate sensitive actions and are
  // always audited)
  "approval.requested": {
    tier: 1,
    description: "An approval was requested for a sensitive action.",
  },
  "approval.granted": {
    tier: 1,
    description: "An approval request was granted by one or more approvers.",
  },
  "approval.denied": {
    tier: 1,
    description: "An approval request was denied by one or more approvers.",
  },
  "approval.expired": {
    tier: 1,
    description: "An approval request expired without a decision.",
  },

  // --- snapshot --- (tier 1: snapshot lifecycle and legal hold are always
  // audited)
  "snapshot.created": {
    tier: 1,
    description: "A snapshot was created on archive, upgrade, or manual trigger.",
  },
  "snapshot.restored": {
    tier: 1,
    description: "A snapshot was restored to a target machine under approval.",
  },
  "snapshot.expired": {
    tier: 1,
    description: "A snapshot passed its retention window and expired.",
  },
  "snapshot.legal_hold_set": {
    tier: 1,
    description: "A legal hold was placed on a snapshot, suspending its retention expiry.",
  },
  "snapshot.legal_hold_cleared": {
    tier: 1,
    description: "A legal hold on a snapshot was cleared.",
  },

  // --- cloud --- (tier 1: credential federation and resource lifecycle are
  // always audited)
  "cloud.credential_federated": {
    tier: 1,
    description: "The org's Azure subscription was federated via OIDC for a subject.",
  },
  "cloud.credential_rejected": {
    tier: 1,
    description: "An attempted cloud credential federation was rejected.",
  },
  "cloud.resource_created": {
    tier: 1,
    description: "A cloud resource was created on the customer's subscription.",
  },
  "cloud.resource_deleted": {
    tier: 1,
    description: "A cloud resource was deleted from the customer's subscription.",
  },

  // --- agent --- (attestation_failed is tier 1 — a compliance-relevant
  // failure; attested is tier 2 — routine successful handshake)
  "agent.attested": {
    tier: 2,
    description: "The control agent successfully attested to the control plane.",
  },
  "agent.attestation_failed": {
    tier: 1,
    description: "The control agent failed to attest to the control plane.",
  },
};
