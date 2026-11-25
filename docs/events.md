# Event Catalogue

Generated from `packages/events`. Do not hand-edit — run `bun run gen-docs` in `packages/events` to regenerate.

## Org

| Type | Tier | Description |
| :--- | :--- | :--- |
| `org.created` | 1 | A new org was created. |
| `org.setting_changed` | 1 | An org- or machine-level default setting was changed. An org package edit (key `package:<name>`) includes the package's `setting`. The Ensure retry wait is key `packages.ensureRetryHours`. The nixpkgs commit `nix:` packages install from is key `packages.nix.snapshot`. |
| `org.integration_connected` | 1 | An IdP, cloud, or secret store integration was connected to the org. |
| `org.integration_removed` | 1 | An IdP, cloud, or secret store integration was removed from the org. |
| `org.apt_repository_added` | 1 | An apt repository outside Ubuntu's own was added after its `apt_repository` approval. Carries URL, suite, components, the signing key's fingerprint and `approvalId`. It installs nothing by itself. |
| `org.apt_repository_removed` | 1 | An approved apt repository was removed after its approval. Packages installed from it stay installed. |
| `org.events_expired` | 1 | The retention sweep deleted events older than the org's retention window. Carries the cutoff and a count, nothing else. |

## Person

| Type | Tier | Description |
| :--- | :--- | :--- |
| `person.added` | 1 | A person was added to the org, manually or via SCIM. |
| `person.activated` | 1 | A person's account was activated. |
| `person.deactivated` | 1 | A person's account was deactivated, manually or via SCIM. |
| `person.role_changed` | 1 | A person's role was changed. |
| `person.email_changed` | 1 | An admin changed a person's email. Every session and CLI token the person held was revoked. |
| `person.approver_changed` | 1 | A person was made an approver, or lost the flag: by an admin, or at sign-in when roles come from the identity provider. |

## IdP roles

Roles from the identity provider (`docs/access.md`). Names and payload fields are the shared IdP
role contract's, the same in Kahuna and SlayZone: `service`, `actor`, `subject`, `source`,
`previousGrants`, `newGrants`, `reason`.

| Type | Tier | Description |
| :--- | :--- | :--- |
| `idp_roles.granted` | 1 | A verified identity provider sign-in set a person's role or approver flag to something new. |
| `idp_roles.denied` | 1 | A sign-in carried no mapped role: refused, role removed, every session and CLI token ended. |
| `idp_roles.revalidated` | 1 | A verified identity provider sign-in confirmed a person's role unchanged. |
| `idp_roles.local_change_refused` | 1 | A role or approver change in Cloudable was refused because roles come from the identity provider. |
| `idp_roles.activation` | 1 | Roles from the identity provider were switched on, off, or remapped. Switching on or remapping ended every human session and credential. |

## Profile

A profile is a named set of settings machines link to (org → profile → machine). See `docs/inheritance.md`. `machineId` is null; `profileId` in the payload says which profile.

| Type | Tier | Description |
| :--- | :--- | :--- |
| `profile.created` | 1 | An admin created a profile. Carries any creation fields it sets: provider, region, size, image. Since 2026-11 also `providerLocked`, `regionLocked`, `sizeLocked`, `imageLocked`. An older event has none; every field it set was locked. |
| `profile.updated` | 1 | An admin changed a profile's name, description, creation fields or their locks. `previous` and `current` hold only the fields that changed. A lock change uses the keys `providerLocked`, `regionLocked`, `sizeLocked`, `imageLocked`. |
| `profile.setting_changed` | 1 | A setting or package on a profile changed. A package edit has key `package:<name>` and stores the lock flag as `pinned`. A cleared setting has `current: null`. |
| `profile.archived` | 1 | An admin archived a profile. No new machine can use it; machines already on it keep its settings. |

## Machine

| Type | Tier | Description |
| :--- | :--- | :--- |
| `machine.created` | 1 | A machine was declared with a name, region, size, and image, and the profile it was created on, if any (`profileId`). |
| `machine.provisioned` | 1 | A machine finished provisioning and has a cloud resource. |
| `machine.provisioning_failed` | 1 | A machine failed to provision at a given stage. |
| `machine.owner_assigned` | 1 | A machine was assigned to a person owner. |
| `machine.profile_assigned` | 1 | An admin moved a machine to another profile, or off one. Carries `profileId` and `previousProfileId`. |
| `machine.owner_cleared` | 1 | A machine's owner was cleared. |
| `machine.started` | 1 | A machine was started. |
| `machine.stopped` | 1 | A machine was stopped by a user, policy, or offboarding. |
| `machine.reimaged` | 1 | A machine's image was replaced with a different image. |
| `machine.setting_changed` | 2 | A machine-level setting was changed, overriding a profile or org default. Package manifest edits (key `package:<name>`) are exempt from tier filtering and always recorded, so per-machine manifest history survives on a tier-1 org the way org-level history already did. A package edit's `previous` and `current` include its `setting` (`allowed`, `ensure_installed` or `ensure_latest`). |
| `machine.offboarded` | 1 | A machine was offboarded from its previous owner under approval. |
| `machine.archived` | 1 | A machine was archived with a final snapshot and retention window. |
| `machine.state_reported` | 2 | The agent reported observed machine state that changed since the last report. |
| `machine.resized` | 1 | A machine was moved to a new size after its `machine_resize` approval. Carries `fromSize`, `toSize` and `approvalId`. |
| `machine.resize_failed` | 1 | An approved resize did not happen; the machine keeps its old size. Carries Azure's `reason`. |
| `machine.apt_repository_configured` | 1 | The agent reported an approved apt repository in place on the machine. Carries `repositoryId`. |
| `machine.apt_repository_removed` | 1 | The agent reported an approved apt repository gone from the machine. Carries `repositoryId`. |
| `machine.drift_detected` | 1 | Undeclared packages, open ports or apt sources were detected on a machine. `undeclaredAptSources` lists apt source URIs that neither Ubuntu nor the org's approved repositories explain. |
| `machine.drift_resolved` | 1 | Detected drift was removed from a machine under approval. For apt sources, `removedAptSources` lists the ones no longer unexplained, and `approvalId` is null. |
| `machine.reconciled` | 2 | Reconciliation removed undeclared software or settings to close a gap with desired state. |
| `machine.first_seen` | 1 | The control agent contacted the control plane for the first time on a machine. |
| `machine.package_action_requested` | 1 | A package install or removal was queued for a machine. Either a person asked for it (actor `person`), or a package set to Ensure installed or Ensure latest version required it (actor `system`). An Ensure install carries `trigger` (the setting), `ensureReason` (`missing`, `outdated`, or `pin_mismatch`: installed, but not at a version the pin allows), `fromVersion` and `toVersion`. |
| `machine.package_action_completed` | 1 | A package install or removal completed on a machine. |
| `machine.package_action_failed` | 1 | A package install or removal failed on a machine, or was collected by the agent and never reported back. |
| `machine.vulnerability_scan_completed` | 1 | A vulnerability scan of a machine finished. Carries counts and the new Critical and High CVE ids; the findings themselves are current state, not events. |
| `machine.vulnerability_scan_failed` | 1 | A vulnerability scan of a machine started and produced no findings, with the reason (for example the vulnerability database was unreachable). |
| `machine.scanner_installed` | 1 | The vulnerability scanner, or one of its scan tools (cargo-auditable, vulnix; field `scanner`), was installed on a machine, or replaced by another version. An admin asked for it by turning scanning on for the org, or for the tools by setting the scan scope to `os_and_tools`. |
| `machine.agent_update` | 1 | Agent release update attempted, confirmed by check-in, failed or rolled back. Includes old/new versions and bundled release identity. |

## Access

| Type | Tier | Description |
| :--- | :--- | :--- |
| `access.certificate_issued` | 1 | A short-lived SSH certificate was issued for a principal. |
| `access.certificate_revoked` | 1 | An SSH certificate was revoked before its expiry. |
| `access.session_started` | 2 | An interactive session started: a terminal, SSH, file browsing on a machine, or a read-only inspection of a snapshot. |
| `access.session_ended` | 2 | An interactive session ended after a given duration. |
| `access.session_denied` | 1 | An interactive session was denied, with the reason it was refused. |
| `access.elevation_requested` | 1 | A person requested elevated access (file recovery or shell) with a reason. |
| `access.elevation_granted` | 1 | Elevated access was granted for a limited time. |
| `access.elevation_expired` | 1 | A granted elevation expired. |

## Approval

| Type | Tier | Description |
| :--- | :--- | :--- |
| `approval.requested` | 1 | An approval was requested for a sensitive action. |
| `approval.granted` | 1 | An approval request was granted by one or more approvers. |
| `approval.denied` | 1 | An approval request was denied by one or more approvers. |
| `approval.expired` | 1 | An approval request expired without a decision. |

## Snapshot

| Type | Tier | Description |
| :--- | :--- | :--- |
| `snapshot.created` | 1 | A snapshot was created on archive, upgrade, or manual trigger. |
| `snapshot.restored` | 1 | A snapshot was restored to a target machine under approval. |
| `snapshot.expired` | 1 | A snapshot passed its retention window: its captured disks were destroyed at the provider and the record was marked expired. |
| `snapshot.data_missing` | 1 | A disk a snapshot recorded was found missing at the provider while its retention window was still open. |
| `snapshot.legal_hold_set` | 1 | A legal hold was placed on a snapshot, suspending its retention expiry. |
| `snapshot.legal_hold_cleared` | 1 | A legal hold on a snapshot was cleared. |

## Cloud

| Type | Tier | Description |
| :--- | :--- | :--- |
| `cloud.credential_federated` | 1 | The org's Azure subscription was federated via OIDC for a subject. |
| `cloud.credential_rejected` | 1 | An attempted cloud credential federation was rejected. |
| `cloud.resource_created` | 1 | A cloud resource was created on the customer's subscription. |
| `cloud.resource_deleted` | 1 | A cloud resource was deleted from the customer's subscription. |

## Agent

| Type | Tier | Description |
| :--- | :--- | :--- |
| `agent.attested` | 2 | The control agent successfully attested to the control plane. |
| `agent.attestation_failed` | 1 | The control agent failed to attest to the control plane. |
