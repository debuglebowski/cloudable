import type { DomainEvent } from "@cloudable/events";
import type { events } from "@cloudable/schema";

/** The shape a raw `db.select().from(events)` row comes back as. */
export type RawEventRow = typeof events.$inferSelect;

export interface EvidenceActor {
  type: RawEventRow["actorType"];
  id: string;
}

/**
 * A pointer into the separate, high-volume `access_command_recorded` store
 * (tier-3 shell capture) — never merged into the normalised evidence
 * stream itself (spec §17's warning about that table's write volume, and
 * the evidence model's own "referenced by correlationId ... never merged"
 * requirement, spec §18). `null` when no command recordings share this
 * event's correlationId.
 */
export interface CommandRecordingRef {
  correlationId: string;
  count: number;
}

/**
 * Cloud-specific detail, exposed as extensions alongside the normalised
 * contract (spec §18). Populated only for the `cloud.*` event domain — the
 * one place Cloudable's Azure-specific vocabulary (subscription ids,
 * resource ids, OIDC subjects) is allowed to leak past the cloud-agnostic
 * shape everything else in `EvidenceRecord` sticks to. `summary` still
 * carries the human-readable line for every event, cloud or not; this is
 * the machine-readable sibling for the cloud domain specifically, not a
 * replacement for it.
 */
export type EvidenceExtensions =
  | { cloud: { subscriptionId: string; subject: string } }
  | { cloud: { subject: string; reason: string } }
  | { cloud: { resourceId: string; kind: string } };

/**
 * The normalised, cloud-agnostic evidence shape auditors read (spec §18).
 *
 * This is a PURE, STATELESS transform over one raw `events` row — nothing
 * declared in this file is ever persisted. Forensics always has the raw
 * `events` row as the ultimate source of truth; this projection can never
 * silently diverge from it because it is recomputed from it on every read,
 * not stored and hand-maintained alongside it.
 */
export interface EvidenceRecord {
  id: string;
  type: string;
  occurredAt: string;
  recordedAt: string;
  orgId: string;
  actor: EvidenceActor;
  machineId: string | null;
  correlationId: string;
  summary: string;
  /** Cloud-domain detail only — `undefined` for every other event type. */
  extensions?: EvidenceExtensions;
  commandRecording: CommandRecordingRef | null;
}

/** Projects one raw `events` row into the normalised evidence shape. */
export function projectEvent(row: RawEventRow, commandRecordingCount = 0): EvidenceRecord {
  const extensions = extensionsFor(row);
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    orgId: row.orgId,
    actor: { type: row.actorType, id: row.actorId },
    machineId: row.machineId,
    correlationId: row.correlationId,
    summary: summarize(row),
    // Spread rather than a plain `extensions: extensions` assignment: with
    // `exactOptionalPropertyTypes` on, an optional field may be omitted but
    // never explicitly set to `undefined`, so a non-cloud event must leave
    // the key out entirely rather than present-with-`undefined`.
    ...(extensions !== undefined ? { extensions } : {}),
    commandRecording:
      commandRecordingCount > 0
        ? { correlationId: row.correlationId, count: commandRecordingCount }
        : null,
  };
}

function assertNever(x: never): never {
  throw new Error(`evidence projection: unhandled event type ${JSON.stringify(x)}`);
}

/**
 * One human/auditor-readable sentence per event type, derived only from the
 * event's type and payload. Written as an exhaustive switch over
 * `DomainEvent["type"]` (via `assertNever` below) so that — mirroring
 * `@cloudable/events`'s `EVENT_METADATA` completeness guarantee — adding a
 * new event type without teaching this function to summarise it is a
 * compile error, not a silently blank row in the audit export.
 */
function summarize(row: RawEventRow): string {
  // The write path (`EventBus.publish`) only ever inserts validated
  // `DomainEvent` rows, so this cast is safe: `row.type` narrows the union
  // and `row.payload` narrows with it in every case below.
  const event = row as unknown as DomainEvent;

  switch (event.type) {
    case "org.created":
      return `Org "${event.payload.name}" was created.`;
    case "org.setting_changed":
      return `Setting "${event.payload.key}" changed from ${JSON.stringify(event.payload.previous)} to ${JSON.stringify(event.payload.current)} at ${event.payload.level} level.`;
    case "org.integration_connected":
      return `A ${event.payload.kind} integration ("${event.payload.identifier}") was connected.`;
    case "org.integration_removed":
      return `A ${event.payload.kind} integration ("${event.payload.identifier}") was removed.`;

    case "person.added":
      return `${event.payload.email} was added to the org (${event.payload.source}).`;
    case "person.activated":
      return "A person's account was activated.";
    case "person.deactivated":
      return `A person's account was deactivated (${event.payload.source}).`;
    case "person.role_changed":
      return `A person's role changed from "${event.payload.previous}" to "${event.payload.current}".`;

    case "machine.created":
      return `Machine "${event.payload.name}" was declared (${event.payload.region}, ${event.payload.size}, ${event.payload.image}).`;
    case "machine.provisioned":
      return `Machine finished provisioning as cloud resource ${event.payload.cloudResourceId}.`;
    case "machine.provisioning_failed":
      return `Machine provisioning failed at stage "${event.payload.stage}": ${event.payload.error}.`;
    case "machine.owner_assigned":
      return event.payload.previousPersonId
        ? `Machine owner changed from ${event.payload.previousPersonId} to ${event.payload.personId}.`
        : `Machine owner assigned to ${event.payload.personId}.`;
    case "machine.owner_cleared":
      return `Machine owner (${event.payload.previousPersonId}) was cleared.`;
    case "machine.started":
      return "Machine was started.";
    case "machine.stopped":
      return `Machine was stopped (${event.payload.initiator}).`;
    case "machine.reimaged":
      return `Machine image was replaced: ${event.payload.previousImage} -> ${event.payload.currentImage}.`;
    case "machine.setting_changed":
      return `Machine setting "${event.payload.key}" was changed, overriding the ${event.payload.overridesLevel} default.`;
    case "machine.offboarded":
      return `Machine was offboarded from ${event.payload.previousOwnerId} under approval ${event.payload.approvalId}.`;
    case "machine.archived":
      return `Machine was archived with snapshot ${event.payload.snapshotId}, retained until ${event.payload.retentionExpiresAt}.`;
    case "machine.state_reported": {
      const keys = Object.keys(event.payload.changes);
      return `Agent reported changed state: ${keys.length > 0 ? keys.join(", ") : "no fields"}.`;
    }
    case "machine.drift_detected":
      return `Drift detected: ${event.payload.undeclaredPackages.length} undeclared package(s), ${event.payload.undeclaredPorts.length} undeclared port(s).`;
    case "machine.drift_resolved": {
      const removed = event.payload.removed;
      return `Drift resolved under approval ${event.payload.approvalId}: removed ${removed.length > 0 ? removed.join(", ") : "nothing"}.`;
    }
    case "machine.reconciled": {
      const keys = Object.keys(event.payload.changes);
      return `Reconciliation closed a gap with desired state: ${keys.length > 0 ? keys.join(", ") : "no fields"}.`;
    }
    case "machine.first_seen":
      return `Control agent (v${event.payload.agentVersion}) contacted the control plane for the first time.`;

    case "access.certificate_issued":
      return `SSH certificate issued to ${event.payload.principal}, expiring ${event.payload.expiresAt} (scope: ${event.payload.machineScope}).`;
    case "access.certificate_revoked":
      return `SSH certificate ${event.payload.certificateId} was revoked: ${event.payload.reason}.`;
    case "access.session_started":
      return `A ${event.payload.method} session started as OS user "${event.payload.osUser}".`;
    case "access.session_ended":
      return `A session ended after ${event.payload.durationSeconds}s.`;
    case "access.session_denied":
      return `A ${event.payload.method} session was denied: ${event.payload.reason}.`;
    case "access.elevation_requested":
      return `Elevated access (${event.payload.level}) was requested: ${event.payload.reason}.`;
    case "access.elevation_granted":
      return `Elevated access (${event.payload.level}) was granted until ${event.payload.expiresAt}.`;
    case "access.elevation_expired":
      return `Elevated access (${event.payload.level}) expired.`;

    case "approval.requested":
      return `Approval requested for ${event.payload.actionType} (${event.payload.mode} mode): ${event.payload.reason}.`;
    case "approval.granted":
      return `Approval for ${event.payload.actionType} was granted by ${event.payload.approverIds.join(", ") || "no approvers recorded"}.`;
    case "approval.denied":
      return `Approval for ${event.payload.actionType} was denied by ${event.payload.approverIds.join(", ") || "no approvers recorded"}: ${event.payload.reason}.`;
    case "approval.expired":
      return `Approval for ${event.payload.actionType} expired without a decision.`;

    case "snapshot.created":
      return `Snapshot created (${event.payload.trigger}) in ${event.payload.region}, ${event.payload.sizeBytes} bytes.`;
    case "snapshot.restored":
      return `Snapshot restored (${event.payload.mode}) to machine ${event.payload.targetMachineId} under approval ${event.payload.approvalId}.`;
    case "snapshot.expired":
      return `Snapshot created ${event.payload.createdAt} expired after its ${event.payload.retentionDays}-day retention window.`;
    case "snapshot.legal_hold_set":
      return `A legal hold was placed on a snapshot: ${event.payload.reason}.`;
    case "snapshot.legal_hold_cleared":
      return `A legal hold on a snapshot was cleared: ${event.payload.reason}.`;

    case "cloud.credential_federated":
      return `Azure subscription ${event.payload.subscriptionId} was federated via OIDC for subject ${event.payload.subject}.`;
    case "cloud.credential_rejected":
      return `Cloud credential federation for subject ${event.payload.subject} was rejected: ${event.payload.reason}.`;
    case "cloud.resource_created":
      return `Cloud resource created: ${event.payload.kind} (${event.payload.resourceId}).`;
    case "cloud.resource_deleted":
      return `Cloud resource deleted: ${event.payload.kind} (${event.payload.resourceId}).`;

    case "agent.attested":
      return `Control agent attested via ${event.payload.method}.`;
    case "agent.attestation_failed":
      return `Control agent attestation failed via ${event.payload.method}: ${event.payload.reason}.`;

    default:
      return assertNever(event);
  }
}

/**
 * Cloud-specific detail for `EvidenceRecord.extensions` (spec §18). Written
 * as its own exhaustive switch — mirroring `summarize`'s — so that adding a
 * new event type to `@cloudable/events` without teaching this function
 * what to do with it fails `bun run typecheck`, exactly like `summarize`.
 * Every non-cloud event type explicitly falls through to `undefined`: they
 * have nothing cloud-specific to add, so `extensions` stays absent for them
 * rather than an empty object.
 */
function extensionsFor(row: RawEventRow): EvidenceExtensions | undefined {
  const event = row as unknown as DomainEvent;

  switch (event.type) {
    case "cloud.credential_federated":
      return {
        cloud: { subscriptionId: event.payload.subscriptionId, subject: event.payload.subject },
      };
    case "cloud.credential_rejected":
      return { cloud: { subject: event.payload.subject, reason: event.payload.reason } };
    case "cloud.resource_created":
    case "cloud.resource_deleted":
      return { cloud: { resourceId: event.payload.resourceId, kind: event.payload.kind } };

    case "org.created":
    case "org.setting_changed":
    case "org.integration_connected":
    case "org.integration_removed":
    case "person.added":
    case "person.activated":
    case "person.deactivated":
    case "person.role_changed":
    case "machine.created":
    case "machine.provisioned":
    case "machine.provisioning_failed":
    case "machine.owner_assigned":
    case "machine.owner_cleared":
    case "machine.started":
    case "machine.stopped":
    case "machine.reimaged":
    case "machine.setting_changed":
    case "machine.offboarded":
    case "machine.archived":
    case "machine.state_reported":
    case "machine.drift_detected":
    case "machine.drift_resolved":
    case "machine.reconciled":
    case "machine.first_seen":
    case "access.certificate_issued":
    case "access.certificate_revoked":
    case "access.session_started":
    case "access.session_ended":
    case "access.session_denied":
    case "access.elevation_requested":
    case "access.elevation_granted":
    case "access.elevation_expired":
    case "approval.requested":
    case "approval.granted":
    case "approval.denied":
    case "approval.expired":
    case "snapshot.created":
    case "snapshot.restored":
    case "snapshot.expired":
    case "snapshot.legal_hold_set":
    case "snapshot.legal_hold_cleared":
    case "agent.attested":
    case "agent.attestation_failed":
      return undefined;

    default:
      return assertNever(event);
  }
}
