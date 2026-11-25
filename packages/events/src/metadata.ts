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
 * Because this is a `Record` keyed by `DomainEvent["type"]`, the compiler
 * enforces completeness: adding a new event type without an entry here is
 * a type error.
 */
export const EVENT_METADATA: Record<DomainEvent["type"], { tier: 1 | 2; description: string }> = {
  // --- org --- (tier 1: org lifecycle and integrations are always audited)
  "org.created": { tier: 1, description: "A new org was created." },
  "org.setting_changed": {
    tier: 1,
    description:
      "An org- or machine-level default setting was changed. An org package edit (key `package:<name>`) includes the package's `setting`. The Ensure retry wait is key `packages.ensureRetryHours`. The nixpkgs commit `nix:` packages install from is key `packages.nix.snapshot`.",
  },
  "org.integration_connected": {
    tier: 1,
    description: "An IdP, cloud, or secret store integration was connected to the org.",
  },
  "org.integration_removed": {
    tier: 1,
    description: "An IdP, cloud, or secret store integration was removed from the org.",
  },
  "org.events_expired": {
    tier: 1,
    description:
      "The retention sweep deleted events older than the org's retention window. Carries the cutoff and a count, nothing else.",
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
  "person.email_changed": {
    tier: 1,
    description:
      "An admin changed a person's email. Every session and CLI token the person held was revoked.",
  },
  "person.approver_changed": {
    tier: 1,
    description:
      "A person was made an approver, or lost the flag: by an admin, or at sign-in when roles come from the identity provider.",
  },
  "person.role_changed": {
    tier: 1,
    description: "A person's role was changed.",
  },

  // --- idp_roles --- (tier 1: every role decision from the identity provider is audited)
  "idp_roles.granted": {
    tier: 1,
    description:
      "A verified identity provider sign-in set a person's role or approver flag to something new.",
  },
  "idp_roles.denied": {
    tier: 1,
    description:
      "A sign-in carried no mapped role: refused, role removed, every session and CLI token ended.",
  },
  "idp_roles.revalidated": {
    tier: 1,
    description: "A verified identity provider sign-in confirmed a person's role unchanged.",
  },
  "idp_roles.local_change_refused": {
    tier: 1,
    description:
      "A role or approver change in Cloudable was refused because roles come from the identity provider.",
  },
  "idp_roles.activation": {
    tier: 1,
    description:
      "Roles from the identity provider were switched on, off, or remapped. Switching on or remapping ended every human session and credential.",
  },

  // --- profile --- (tier 1: a profile change reaches every machine on it)
  "profile.created": {
    tier: 1,
    description:
      "An admin created a profile: a named set of settings machines link to. Carries any creation fields it sets (provider, region, size, image).",
  },
  "profile.updated": {
    tier: 1,
    description:
      "An admin changed a profile's name, description or creation fields. Creation fields can change only while no machine that is not archived uses the profile.",
  },
  "profile.setting_changed": {
    tier: 1,
    description:
      "A setting or package on a profile changed. Every machine on the profile that has not overridden it follows. A package edit has key `package:<name>` and includes the package's `setting`.",
  },
  "profile.archived": {
    tier: 1,
    description:
      "An admin archived a profile. No new machine can use it; machines already on it keep reading their settings from it.",
  },
  "org.apt_repository_added": {
    tier: 1,
    description:
      "An apt repository outside Ubuntu's own was added to the org after its approval. Carries its URL, suite, components and the signing key's fingerprint. It installs nothing by itself.",
  },
  "org.apt_repository_removed": {
    tier: 1,
    description:
      "An approved apt repository was removed after its approval. Packages installed from it stay installed.",
  },
  "machine.apt_repository_configured": {
    tier: 1,
    description: "The agent reported an approved apt repository in place on the machine.",
  },
  "machine.apt_repository_removed": {
    tier: 1,
    description: "The agent reported an approved apt repository gone from the machine.",
  },
  "machine.profile_assigned": {
    tier: 1,
    description:
      "An admin moved a machine to another profile, or off one. The machine's settings now resolve through the new profile.",
  },

  // --- machine --- (tier 1 by default; setting_changed/state_reported/
  // reconciled are tier 2, routine operational updates)
  "machine.created": {
    tier: 1,
    description:
      "A machine was declared with a name, region, size, and image, and the profile it was created on, if any.",
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
    description:
      "A machine-level setting was changed, overriding a profile or org default. Package manifest edits (key `package:<name>`) are exempt from tier filtering and always recorded, so per-machine manifest history survives on a tier-1 org the way org-level history already did. A package edit's `previous` and `current` include its `setting` (`allowed`, `ensure_installed` or `ensure_latest`).",
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
    description:
      "Undeclared packages, open ports or apt sources were detected on a machine. An apt source counts when neither Ubuntu nor the org's approved repositories explain it.",
  },
  "machine.drift_resolved": {
    tier: 1,
    description: "Detected drift was removed from a machine under approval.",
  },
  "machine.reconciled": {
    tier: 2,
    description:
      "Reconciliation removed undeclared software or settings to close a gap with desired state.",
  },
  "machine.first_seen": {
    tier: 1,
    description: "The control agent contacted the control plane for the first time on a machine.",
  },
  // Tier 1, all three. Software arriving on or leaving a governed machine is
  // the question an auditor is here to ask, and a tier-2 event is one
  // logging-tier setting away from never being written at all.
  "machine.package_action_requested": {
    tier: 1,
    description:
      "A package install or removal was queued for a machine. Either a person asked for it (actor `person`), or a package set to Ensure installed or Ensure latest version required it (actor `system`). An Ensure install carries `trigger` (the setting), `ensureReason` (`missing` or `outdated`), `fromVersion` and `toVersion`.",
  },
  "machine.package_action_completed": {
    tier: 1,
    description: "A package install or removal completed on a machine.",
  },
  "machine.package_action_failed": {
    tier: 1,
    description:
      "A package install or removal failed on a machine, or was collected by the agent and never reported back.",
  },
  // Tier 1: scan results are the evidence for the vulnerability-management control, and
  // installing the scanner is a change to a governed machine. Neither may be filtered out.
  "machine.vulnerability_scan_completed": {
    tier: 1,
    description:
      "A vulnerability scan of a machine finished. Carries counts and the new Critical and High CVE ids; the findings themselves are current state, not events.",
  },
  "machine.vulnerability_scan_failed": {
    tier: 1,
    description:
      "A vulnerability scan of a machine started and produced no findings, with the reason (for example the vulnerability database was unreachable).",
  },
  "machine.agent_update": {
    tier: 1,
    description:
      "Agent release update attempted, confirmed by check-in, failed or rolled back. Includes old/new versions and bundled release identity.",
  },
  "machine.scanner_installed": {
    tier: 1,
    description:
      "The vulnerability scanner, or one of its scan tools (cargo-auditable, vulnix; field `scanner`), was installed on a machine, or replaced by another version. An admin asked for it by turning scanning on for the org, or for the tools by setting the scan scope to `os_and_tools`.",
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
    description:
      "An interactive session started: a terminal, SSH, file browsing on a machine, or a read-only inspection of a snapshot.",
  },
  "access.session_ended": {
    tier: 2,
    description: "An interactive session ended after a given duration.",
  },
  "access.session_denied": {
    tier: 1,
    description: "An interactive session was denied, with the reason it was refused.",
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
    description:
      "A snapshot passed its retention window: its captured disks were destroyed at the provider and the record was marked expired.",
  },
  "snapshot.data_missing": {
    tier: 1,
    description:
      "A disk a snapshot recorded was found missing at the provider while its retention window was still open.",
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
