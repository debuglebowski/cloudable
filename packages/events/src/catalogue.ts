import type { AccessEvent } from "./domains/access";
import type { AgentEvent } from "./domains/agent";
import type { ApprovalEvent } from "./domains/approval";
import type { CloudEvent } from "./domains/cloud";
import type { MachineEvent } from "./domains/machine";
import type { OrgEvent } from "./domains/org";
import type { PersonEvent } from "./domains/person";
import type { SnapshotEvent } from "./domains/snapshot";

export type DomainEvent =
  | OrgEvent
  | PersonEvent
  | MachineEvent
  | AccessEvent
  | ApprovalEvent
  | SnapshotEvent
  | CloudEvent
  | AgentEvent;

/**
 * The full, ordered catalogue of event type names.
 *
 * This is a public interface: additive only, never renamed
 * or removed. `__tests__/catalogue.snapshot.test.ts` snapshots this array
 * so that any rename/removal fails CI.
 */
export const EVENT_TYPES = [
  // --- org ---
  "org.created",
  "org.setting_changed",
  "org.integration_connected",
  "org.integration_removed",

  // --- person ---
  "person.added",
  "person.activated",
  "person.deactivated",
  "person.role_changed",

  // --- machine ---
  "machine.created",
  "machine.provisioned",
  "machine.provisioning_failed",
  "machine.owner_assigned",
  "machine.owner_cleared",
  "machine.started",
  "machine.stopped",
  "machine.reimaged",
  "machine.setting_changed",
  "machine.offboarded",
  "machine.archived",
  "machine.state_reported",
  "machine.drift_detected",
  "machine.drift_resolved",
  "machine.reconciled",
  "machine.first_seen",

  // --- access ---
  "access.certificate_issued",
  "access.certificate_revoked",
  "access.session_started",
  "access.session_ended",
  "access.session_denied",
  "access.elevation_requested",
  "access.elevation_granted",
  "access.elevation_expired",

  // --- approval ---
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "approval.expired",

  // --- snapshot ---
  "snapshot.created",
  "snapshot.restored",
  "snapshot.expired",
  "snapshot.legal_hold_set",
  "snapshot.legal_hold_cleared",

  // --- cloud ---
  "cloud.credential_federated",
  "cloud.credential_rejected",
  "cloud.resource_created",
  "cloud.resource_deleted",

  // --- agent ---
  "agent.attested",
  "agent.attestation_failed",
] as const satisfies ReadonlyArray<DomainEvent["type"]>;
