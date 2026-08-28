import { useQuery } from "@tanstack/react-query";

import { BASE_URL } from "@/lib/api-client";

/**
 * Audit domain: timeline (raw event feed) and evidence export (events → checks →
 * controls, grouped by control per docs/spec.md §19/§20).
 *
 * The compliance control-map / evidence-export endpoints and evidence projection
 * (backend unit 10) are not present on the `main` this unit forked from — this file
 * mocks realistic data shaped like the real projection so the page can be built and
 * reviewed now. Swap `fetchAuditTimeline` / `fetchControlEvidence` for real `apiGet`
 * calls once those endpoints land; the query keys and return shapes are designed to
 * carry over unchanged.
 */

/** Expected backend export endpoints (§19 "Exports"). 404 today; see PR notes. */
export const AUDIT_EXPORT_URLS = {
  assetInventoryCsv: `${BASE_URL}/api/v1/compliance/exports/asset-inventory.csv`,
  openFindingsCsv: `${BASE_URL}/api/v1/compliance/exports/open-findings.csv`,
} as const;

/** Domain-first query key tuples. */
export const auditKeys = {
  all: ["audit"] as const,
  timeline: () => [...auditKeys.all, "timeline"] as const,
  evidence: () => [...auditKeys.all, "evidence"] as const,
};

export type AuditActorType = "person" | "system" | "agent" | "idp";

/** One row of the timeline view. Shape mirrors the event envelope in packages/events. */
export interface AuditTimelineEntry {
  id: string;
  /** Catalogue event type, e.g. "machine.drift_detected". */
  type: string;
  occurredAt: string;
  recordedAt: string;
  actorType: AuditActorType;
  actorId?: string;
  machineId?: string;
  summary: string;
}

export type ControlCheckStatus = "pass" | "fail" | "unknown";
export type FindingSeverity = "low" | "medium" | "high";

export interface OpenFinding {
  id: string;
  summary: string;
  severity: FindingSeverity;
  /** ISO date the finding was first seen (§19 "Finding age"). */
  openSince: string;
}

/** One of the six v1 compliance checks (§19), as evidence for a control. */
export interface ControlCheckEvidence {
  id: string;
  checkLabel: string;
  status: ControlCheckStatus;
  detail: string;
  findings: OpenFinding[];
}

/** A control and the checks that evidence it — many-to-many in reality, one group per control here. */
export interface ControlEvidenceGroup {
  id: string;
  control: string;
  framework: string;
  checks: ControlCheckEvidence[];
}

const MOCK_TIMELINE: AuditTimelineEntry[] = [
  {
    id: "01J8Q3F1V6K9X5M2N4P7R8T0W1",
    type: "access.session_denied",
    occurredAt: "2026-08-27T18:42:10Z",
    recordedAt: "2026-08-27T18:42:11Z",
    actorType: "system",
    machineId: "mach-0231",
    summary: "Web terminal session denied for priya@acme.com: certificate revoked.",
  },
  {
    id: "01J8Q3EWD2H4B7C1E9F3G5J6K8",
    type: "org.setting_changed",
    occurredAt: "2026-08-27T16:05:33Z",
    recordedAt: "2026-08-27T16:05:35Z",
    actorType: "person",
    actorId: "priya@acme.com",
    summary: "priya@acme.com changed default logging tier from Metadata only to Session-level.",
  },
  {
    id: "01J8Q3ENT8M0P2Q4R6S8U0V2W4",
    type: "approval.denied",
    occurredAt: "2026-08-27T15:26:44Z",
    recordedAt: "2026-08-27T15:26:44Z",
    actorType: "person",
    actorId: "priya@acme.com",
    machineId: "mach-0098",
    summary: "priya@acme.com denied sam@acme.com's break-glass request for mach-0098: reason insufficient.",
  },
  {
    id: "01J8Q3EK5N7Q9S1U3W5X7Z9B1D",
    type: "approval.requested",
    occurredAt: "2026-08-27T15:20:00Z",
    recordedAt: "2026-08-27T15:20:01Z",
    actorType: "person",
    actorId: "sam@acme.com",
    machineId: "mach-0098",
    summary: "sam@acme.com requested approval for an interactive shell break-glass session on mach-0098.",
  },
  {
    id: "01J8Q3EF3R5T7V9X1Z3B5D7F9H",
    type: "machine.drift_detected",
    occurredAt: "2026-08-27T14:03:11Z",
    recordedAt: "2026-08-27T14:03:40Z",
    actorType: "agent",
    machineId: "mach-0117",
    summary: "Agent reported 'ripgrep' installed outside the declared package manifest.",
  },
  {
    id: "01J8Q3EA1V3X5Z7B9D1F3H5J7L",
    type: "access.certificate_revoked",
    occurredAt: "2026-08-27T09:12:04Z",
    recordedAt: "2026-08-27T09:12:05Z",
    actorType: "system",
    machineId: "mach-0231",
    summary: "SSH certificate for owner priya@acme.com revoked following offboarding.",
  },
  {
    id: "01J8Q3E60X2Z4B6D8F0H2J4L6N",
    type: "machine.offboarded",
    occurredAt: "2026-08-27T09:12:00Z",
    recordedAt: "2026-08-27T09:12:03Z",
    actorType: "person",
    actorId: "priya@acme.com",
    machineId: "mach-0231",
    summary: "priya@acme.com offboarded mach-0231; certificate revocation and retention clock started.",
  },
  {
    id: "01J8Q3E1Y8A0C2E4G6J8L0N2P4",
    type: "agent.attestation_failed",
    occurredAt: "2026-08-27T06:10:00Z",
    recordedAt: "2026-08-27T06:10:04Z",
    actorType: "system",
    machineId: "mach-0099",
    summary: "Attestation rejected for mach-0099: join token expired.",
  },
  {
    id: "01J8Q3DVW6Y8A0C2E4G6I8K0M2",
    type: "machine.state_reported",
    occurredAt: "2026-08-27T02:00:00Z",
    recordedAt: "2026-08-27T06:14:52Z",
    actorType: "agent",
    machineId: "mach-0305",
    summary: "mach-0305 woke from sleep and reported state after a multi-hour gap.",
  },
  {
    id: "01J8Q3DQU4W6Y8A0C2E4G6I8K0",
    type: "cloud.credential_federated",
    occurredAt: "2026-08-26T22:40:00Z",
    recordedAt: "2026-08-26T22:40:05Z",
    actorType: "system",
    summary: "Workload identity federation token minted for tenant acme (subject cloudable:tenant:acme).",
  },
  {
    id: "01J8Q3DKS2U4W6Y8A0C2E4G6I8",
    type: "snapshot.legal_hold_set",
    occurredAt: "2026-08-26T19:15:00Z",
    recordedAt: "2026-08-26T19:15:02Z",
    actorType: "person",
    actorId: "priya@acme.com",
    machineId: "mach-0044",
    summary: "priya@acme.com placed a legal hold on the archived snapshot for mach-0044.",
  },
  {
    id: "01J8Q3DFQ0S2U4W6Y8A0C2E4G6",
    type: "person.deactivated",
    occurredAt: "2026-08-26T11:00:00Z",
    recordedAt: "2026-08-26T11:00:01Z",
    // actorType "idp": the IdP sync is the actor, not the person it deactivated —
    // actorId names who/what did this, not the affected subject (see summary).
    actorType: "idp",
    summary: "IdP deactivated sam@acme.com; dependent machine ownership checks re-evaluated.",
  },
  {
    id: "01J8Q3DAN8Q0S2U4W6Y8A0C2E4",
    type: "snapshot.expired",
    occurredAt: "2026-08-26T03:00:00Z",
    recordedAt: "2026-08-26T03:00:02Z",
    actorType: "system",
    machineId: "mach-0501",
    summary: "Archived snapshot for mach-0501 passed its 30-day retention window; volume data purged.",
  },
  {
    id: "01J8Q3D5L6O8Q0S2U4W6Y8A0C2",
    type: "access.elevation_granted",
    occurredAt: "2026-08-25T20:00:00Z",
    recordedAt: "2026-08-25T20:00:01Z",
    actorType: "person",
    actorId: "priya@acme.com",
    machineId: "mach-0098",
    summary: "priya@acme.com granted a 1h interactive shell elevation on mach-0098 to sam@acme.com.",
  },
];

const MOCK_EVIDENCE: ControlEvidenceGroup[] = [
  {
    id: "access-deprovisioning",
    control: "Access is revoked within policy window",
    framework: "ISO 27001 A.9.2.6 · SOC 2 CC6.2",
    checks: [
      {
        id: "check-offboarding-revocation",
        checkLabel: "Access revoked on offboarding",
        status: "fail",
        detail: "A certificate is still valid 24h after the owner was offboarded.",
        findings: [
          {
            id: "finding-cert-mach-0231",
            summary: "SSH certificate for mach-0231 still valid 36h after owner offboarded",
            severity: "high",
            openSince: "2026-08-14",
          },
        ],
      },
      {
        id: "check-elevation-approved",
        checkLabel: "Elevated access was approved",
        status: "pass",
        detail: "Every break-glass and admin session in the audit window has an approval record.",
        findings: [],
      },
    ],
  },
  {
    id: "asset-authorized-software",
    control: "Only declared software is installed",
    framework: "ISO 27001 A.8.1.1 · SOC 2 CC6.1",
    checks: [
      {
        id: "check-no-undeclared-software",
        checkLabel: "No undeclared software",
        status: "fail",
        detail: "Installed packages diverge from the resolved manifest on 2 machines.",
        findings: [
          {
            id: "finding-drift-mach-0117",
            summary: "mach-0117 has 'ripgrep' installed outside the manifest",
            severity: "medium",
            openSince: "2026-08-14",
          },
          {
            id: "finding-drift-mach-0098",
            summary: "mach-0098 has 'docker-compose' installed outside the manifest",
            severity: "low",
            openSince: "2026-08-24",
          },
        ],
      },
      {
        id: "check-machines-reporting",
        checkLabel: "Machines are reporting",
        status: "pass",
        detail: "Every machine's last-verified timestamp is inside the expected reconcile window.",
        findings: [],
      },
    ],
  },
  {
    id: "asset-ownership",
    control: "Every asset has an accountable owner",
    framework: "ISO 27001 A.8.1.2",
    checks: [
      {
        id: "check-active-owner",
        checkLabel: "Machine has an active owner",
        status: "pass",
        detail: "Every machine's owner is present and active in the IdP.",
        findings: [],
      },
    ],
  },
  {
    id: "retention",
    control: "Retention windows are honoured",
    framework: "SOC 2 CC6.5",
    checks: [
      {
        id: "check-retention-honoured",
        checkLabel: "Retention is honoured",
        status: "unknown",
        detail: "Legal-hold exceptions are not yet distinguished from expired snapshots in this build — not covered.",
        findings: [],
      },
    ],
  },
];

async function fetchAuditTimeline(): Promise<AuditTimelineEntry[]> {
  return MOCK_TIMELINE;
}

async function fetchControlEvidence(): Promise<ControlEvidenceGroup[]> {
  return MOCK_EVIDENCE;
}

export function useAuditTimeline() {
  return useQuery({ queryKey: auditKeys.timeline(), queryFn: fetchAuditTimeline });
}

export function useControlEvidence() {
  return useQuery({ queryKey: auditKeys.evidence(), queryFn: fetchControlEvidence });
}
