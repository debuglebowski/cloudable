/**
 * Common envelope shared by every event in the catalogue.
 *
 * Events are append-only (invariant 2): once recorded, an envelope + payload
 * is never updated or deleted. Retention is handled by expiry, not deletion.
 */
export interface EventEnvelope {
  id: string;
  occurredAt: Date;
  recordedAt: Date;
  orgId: string;
  actorType: "person" | "system" | "agent" | "idp";
  actorId: string;
  machineId: string | null;
  correlationId: string;
  schemaVersion: number;
}
