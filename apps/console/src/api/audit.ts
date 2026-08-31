import { useQuery } from "@tanstack/react-query";

import { apiGet, BASE_URL } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";

/**
 * Audit domain: timeline (raw event feed) and evidence export (events →
 * checks → controls, grouped by control per docs/spec.md §19/§20). Wired to
 * the real `evidence/api.ts` (timeline) and `http/routes/compliance.ts`
 * (control-map + findings + CSV exports) — both already existed and
 * worked; this file was never updated after they merged.
 */

export const AUDIT_EXPORT_URLS = {
  assetInventoryCsv: `${BASE_URL}/api/v1/compliance/exports/asset-inventory.csv?orgId=${CURRENT_ORG_ID}`,
  // Real path is exports/findings.csv, not open-findings.csv — the mock's
  // guessed name never got corrected against the real endpoint unit 10 shipped.
  openFindingsCsv: `${BASE_URL}/api/v1/compliance/exports/findings.csv?orgId=${CURRENT_ORG_ID}`,
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
  actorId?: string | undefined;
  machineId?: string | undefined;
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

interface EvidenceRecordWire {
  id: string;
  type: string;
  occurredAt: string;
  recordedAt: string;
  actor: { type: AuditActorType; id: string };
  machineId: string | null;
  summary: string;
}

async function fetchAuditTimeline(): Promise<AuditTimelineEntry[]> {
  const res = await apiGet<{ data: EvidenceRecordWire[] }>(
    `/api/v1/evidence?orgId=${CURRENT_ORG_ID}&limit=100`,
  );
  return res.data.map((e) => ({
    id: e.id,
    type: e.type,
    occurredAt: e.occurredAt,
    recordedAt: e.recordedAt,
    actorType: e.actor.type,
    actorId: e.actor.id,
    machineId: e.machineId ?? undefined,
    summary: e.summary,
  }));
}

interface ControlMapEntryWire {
  id: string;
  label: string;
  framework: string;
  status: "implemented" | "manual_action_required" | "not_covered";
  evidencedByCheckIds: string[];
}

interface ComplianceFindingWire {
  machineId: string | null;
  firstSeenAt: string;
  ageDays: number;
  detail: Record<string, unknown>;
}

interface ComplianceCheckResultWire {
  checkId: string;
  label: string;
  controlRefs: string[];
  status: "pass" | "fail" | "not_applicable";
  /**
   * Fixed per check (which of the six v1 checks tends to matter more if it
   * fails), not a fabricated per-finding value — every finding under the
   * same check shares it. Sourced from the backend's
   * `ComplianceCheck.severity` (the one place severity is defined — see
   * `apps/control-plane/src/domain/compliance/types.ts`), not a second,
   * independently-maintained classification here.
   */
  severity: FindingSeverity;
  findings: ComplianceFindingWire[];
}

function summarizeDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return entries.length > 0 ? entries.join(", ") : "No further detail.";
}

function toCheckStatus(status: ComplianceCheckResultWire["status"]): ControlCheckStatus {
  return status === "not_applicable" ? "unknown" : status;
}

function checkDetailLine(check: ComplianceCheckResultWire): string {
  if (check.status === "not_applicable") {
    return "Not applicable to this org's current fleet — applicability-gated per spec §19.";
  }
  if (check.findings.length === 0) {
    return "No open findings.";
  }
  return `${check.findings.length} open finding${check.findings.length === 1 ? "" : "s"}.`;
}

async function fetchControlEvidence(): Promise<ControlEvidenceGroup[]> {
  const [controlMap, findingsRes] = await Promise.all([
    apiGet<{ controls: ControlMapEntryWire[] }>("/api/v1/compliance/control-map"),
    apiGet<{ checks: ComplianceCheckResultWire[] }>(
      `/api/v1/compliance/findings?orgId=${CURRENT_ORG_ID}`,
    ),
  ]);
  const checksById = new Map(findingsRes.checks.map((c) => [c.checkId, c]));

  return controlMap.controls.map((control) => {
    const checks: ControlCheckEvidence[] = control.evidencedByCheckIds
      .map((checkId) => checksById.get(checkId))
      .filter((check): check is ComplianceCheckResultWire => check !== undefined)
      .map((check) => ({
        id: check.checkId,
        checkLabel: check.label,
        status: toCheckStatus(check.status),
        detail: checkDetailLine(check),
        findings: check.findings.map((finding, index) => ({
          id: `${check.checkId}:${finding.machineId ?? "org"}:${index}`,
          summary: finding.machineId
            ? `${finding.machineId}: ${summarizeDetail(finding.detail)}`
            : summarizeDetail(finding.detail),
          severity: check.severity,
          openSince: finding.firstSeenAt,
        })),
      }));

    // A control with no implemented check evidencing it (spec §19: "most of
    // ISO Annex A... has no bearing on the product and must not be claimed
    // as evidenced") still renders — as an explicit "not covered" row, not
    // silently dropped. Dashboards full of N/A train people to ignore them,
    // per spec, but that's an argument for a clear N/A row, not for hiding
    // the control entirely.
    if (checks.length === 0) {
      checks.push({
        id: `${control.id}:not-covered`,
        checkLabel: "No implemented check",
        status: "unknown",
        detail:
          control.status === "not_covered"
            ? "Not covered by any of the six v1 compliance checks."
            : "Manual action required — no automated check evidences this control yet.",
        findings: [],
      });
    }

    return {
      id: control.id,
      control: control.label,
      framework: control.framework,
      checks,
    };
  });
}

export function useAuditTimeline() {
  return useQuery({ queryKey: auditKeys.timeline(), queryFn: fetchAuditTimeline });
}

export function useControlEvidence() {
  return useQuery({ queryKey: auditKeys.evidence(), queryFn: fetchControlEvidence });
}
