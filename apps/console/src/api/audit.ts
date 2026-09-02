import { useQuery } from "@tanstack/react-query";

import type { BadgeProps } from "@/components/ui/badge";
import { BASE_URL, apiGet } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";

/**
 * Audit domain: timeline (raw event feed) and evidence export (events →
 * checks → controls, grouped by control). Wired to
 * the real `evidence/api.ts` (timeline) and `http/routes/compliance.ts`
 * (control-map + findings + CSV exports) — both already existed and
 * worked; this file was never updated after they merged.
 */

export const AUDIT_EXPORT_URLS = {
  assetInventoryCsv: `${BASE_URL}/api/v1/compliance/exports/asset-inventory.csv`,
  // Real path is exports/findings.csv, not open-findings.csv — the mock's
  // guessed name never got corrected against the real endpoint unit 10 shipped.
  openFindingsCsv: `${BASE_URL}/api/v1/compliance/exports/findings.csv`,
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
  /** ISO date the finding was first seen ("Finding age"). */
  openSince: string;
  /** `undefined` when the finding isn't attributable to one machine. */
  machineId?: string | undefined;
}

/** One of the six v1 compliance checks, as evidence for a control. */
export interface ControlCheckEvidence {
  id: string;
  checkLabel: string;
  status: ControlCheckStatus;
  detail: string;
  findings: OpenFinding[];
  /** Median age (in days) of this check's currently-open findings — `null` when there are none. */
  medianAgeDays: number | null;
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
  const res = await apiGet<{ data: EvidenceRecordWire[] }>("/api/v1/evidence?limit=100");
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
  findings: ComplianceFindingWire[];
  medianAgeDays: number | null;
}

/**
 * The real backend has no per-finding severity — findings are a fact
 * ("this machine diverges from its manifest"), not a graded risk score.
 * This is a fixed, check-level editorial classification (which of the six
 * v1 checks tends to matter more if it fails), not a fabricated per-finding
 * value — every finding under the same check gets the same severity.
 * Unlisted/future checks default to "medium".
 */
const CHECK_SEVERITY: Record<string, FindingSeverity> = {
  "elevated-access-approved": "high",
  "access-revoked-on-offboarding": "high",
  "retention-honoured": "medium",
  "no-undeclared-software": "medium",
  "active-owner": "medium",
  "machines-reporting": "low",
};

export const SEVERITY_VARIANT: Record<FindingSeverity, BadgeProps["variant"]> = {
  high: "destructive",
  medium: "drift",
  low: "outline",
};

export function daysOpen(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
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
    return "Not applicable to this org's current fleet.";
  }
  if (check.findings.length === 0) {
    return "No open findings.";
  }
  return `${check.findings.length} open finding${check.findings.length === 1 ? "" : "s"}.`;
}

/** Shared by `fetchControlEvidence` and `fetchComplianceChecks` — one finding-mapping rule. */
function mapFindings(check: ComplianceCheckResultWire): OpenFinding[] {
  return check.findings.map((finding, index) => ({
    id: `${check.checkId}:${finding.machineId ?? "org"}:${index}`,
    summary: finding.machineId
      ? `${finding.machineId}: ${summarizeDetail(finding.detail)}`
      : summarizeDetail(finding.detail),
    severity: CHECK_SEVERITY[check.checkId] ?? "medium",
    openSince: finding.firstSeenAt,
    machineId: finding.machineId ?? undefined,
  }));
}

async function fetchControlEvidence(): Promise<ControlEvidenceGroup[]> {
  // `/api/v1/compliance/*` still takes `orgId` as a plain query param, not derived from
  // the session — same known gap `api/compliance.ts`'s `useControlMap` already works
  // around with this exact constant (see its own doc comment).
  const [controlMap, findingsRes] = await Promise.all([
    apiGet<{ controls: ControlMapEntryWire[] }>(
      `/api/v1/compliance/control-map?orgId=${CURRENT_ORG_ID}`,
    ),
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
        medianAgeDays: check.medianAgeDays,
        findings: mapFindings(check),
      }));

    // A control with no implemented check evidencing it ("most of ISO Annex
    // A... has no bearing on the product and must not be claimed as
    // evidenced") still renders — as an explicit "not covered" row, not
    // silently dropped. Dashboards full of N/A train people to ignore them,
    // but that's an argument for a clear N/A row, not for hiding the
    // control entirely.
    if (checks.length === 0) {
      checks.push({
        id: `${control.id}:not-covered`,
        checkLabel: "No implemented check",
        status: "unknown",
        detail:
          control.status === "not_covered"
            ? "Not covered by any of the six v1 compliance checks."
            : "Manual action required — no automated check evidences this control yet.",
        medianAgeDays: null,
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

/** One of the six v1 checks, ungrouped by control — the shape a machine-scoped view
 * wants ("does this check implicate this machine"), vs. `ControlEvidenceGroup`'s
 * control/framework grouping (compliance-taxonomy detail an auditor cares about, a
 * single machine's page doesn't) and its synthetic "not covered" placeholder checks. */
export interface ComplianceCheckSummary {
  id: string;
  label: string;
  status: ControlCheckStatus;
  findings: OpenFinding[];
  medianAgeDays: number | null;
}

async function fetchComplianceChecks(): Promise<ComplianceCheckSummary[]> {
  const findingsRes = await apiGet<{ checks: ComplianceCheckResultWire[] }>(
    `/api/v1/compliance/findings?orgId=${CURRENT_ORG_ID}`,
  );
  return findingsRes.checks.map((check) => ({
    id: check.checkId,
    label: check.label,
    status: toCheckStatus(check.status),
    medianAgeDays: check.medianAgeDays,
    findings: mapFindings(check),
  }));
}

export function useAuditTimeline() {
  return useQuery({ queryKey: auditKeys.timeline(), queryFn: fetchAuditTimeline });
}

export function useControlEvidence() {
  return useQuery({ queryKey: auditKeys.evidence(), queryFn: fetchControlEvidence });
}

export function useComplianceChecks() {
  return useQuery({
    queryKey: [...auditKeys.all, "checks"] as const,
    queryFn: fetchComplianceChecks,
  });
}
