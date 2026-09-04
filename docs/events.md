# Event Catalogue

Generated from `packages/events`. Do not hand-edit — run `bun run gen-docs` in `packages/events` to regenerate.

## Org

| Type | Tier | Description |
| :--- | :--- | :--- |
| `org.created` | 1 | A new org was created. |
| `org.setting_changed` | 1 | An org- or machine-level default setting was changed. |
| `org.integration_connected` | 1 | An IdP, cloud, or secret store integration was connected to the org. |
| `org.integration_removed` | 1 | An IdP, cloud, or secret store integration was removed from the org. |

## Person

| Type | Tier | Description |
| :--- | :--- | :--- |
| `person.added` | 1 | A person was added to the org, manually or via SCIM. |
| `person.activated` | 1 | A person's account was activated. |
| `person.deactivated` | 1 | A person's account was deactivated, manually or via SCIM. |
| `person.role_changed` | 1 | A person's role was changed. |

## Machine

| Type | Tier | Description |
| :--- | :--- | :--- |
| `machine.created` | 1 | A machine was declared with a name, region, size, and image. |
| `machine.provisioned` | 1 | A machine finished provisioning and has a cloud resource. |
| `machine.provisioning_failed` | 1 | A machine failed to provision at a given stage. |
| `machine.owner_assigned` | 1 | A machine was assigned to a person owner. |
| `machine.owner_cleared` | 1 | A machine's owner was cleared. |
| `machine.started` | 1 | A machine was started. |
| `machine.stopped` | 1 | A machine was stopped by a user, policy, or offboarding. |
| `machine.reimaged` | 1 | A machine's image was replaced with a different image. |
| `machine.setting_changed` | 2 | A machine-level setting was changed, overriding a template or org default. |
| `machine.offboarded` | 1 | A machine was offboarded from its previous owner under approval. |
| `machine.archived` | 1 | A machine was archived with a final snapshot and retention window. |
| `machine.state_reported` | 2 | The agent reported observed machine state that changed since the last report. |
| `machine.drift_detected` | 1 | Undeclared packages or open ports were detected on a machine. |
| `machine.drift_resolved` | 1 | Detected drift was removed from a machine under approval. |
| `machine.reconciled` | 2 | Reconciliation removed undeclared software or settings to close a gap with desired state. |
| `machine.first_seen` | 1 | The control agent contacted the control plane for the first time on a machine. |

## Access

| Type | Tier | Description |
| :--- | :--- | :--- |
| `access.certificate_issued` | 1 | A short-lived SSH certificate was issued for a principal. |
| `access.certificate_revoked` | 1 | An SSH certificate was revoked before its expiry. |
| `access.session_started` | 2 | A terminal or SSH session started on a machine. |
| `access.session_ended` | 2 | A terminal or SSH session ended after a given duration. |
| `access.session_denied` | 1 | A terminal or SSH session was denied access to a machine. |
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
| `snapshot.expired` | 1 | A snapshot passed its retention window and expired. |
| `snapshot.legal_hold_set` | 1 | A legal hold was placed on a snapshot, suspending its retention expiry. |
| `snapshot.legal_hold_cleared` | 1 | A legal hold on a snapshot was cleared. |

## Cloud

`cloud.credential_federated`/`cloud.credential_rejected` are currently dormant — the
customer-federated (BYOC) code that emitted them was removed (`docs/cloud-auth.md`). They stay
declared here per the catalogue's additive-only invariant (#11 in `CLAUDE.md`); nothing emits
them in the shipped self-host path.

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
