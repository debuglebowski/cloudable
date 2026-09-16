import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import type { BadgeProps } from "@/components/ui/badge";
import { apiGet, apiGetText } from "@/lib/api-client";

/**
 * Audit domain: timeline (raw event feed) and evidence export (events →
 * checks → controls, grouped by control). Wired to
 * the real `evidence/api.ts` (timeline) and `http/routes/compliance.ts`
 * (control-map + findings + CSV exports) — both already existed and
 * worked; this file was never updated after they merged.
 */

/** The two evidence exports, by the path each actually lives at. (`findings.csv`, not
 * `open-findings.csv` — the mock's guessed name was never corrected against the real
 * endpoint.) Fetched with credentials rather than linked to; see `apiGetText`. */
export const AUDIT_EXPORTS = {
  assetInventory: {
    path: "/api/v1/compliance/exports/asset-inventory.csv",
    filename: "asset-inventory.csv",
    label: "Asset inventory",
  },
  openFindings: {
    path: "/api/v1/compliance/exports/findings.csv",
    filename: "open-findings.csv",
    label: "Open findings",
  },
} as const;

export type AuditExport = (typeof AUDIT_EXPORTS)[keyof typeof AUDIT_EXPORTS];

/** Hands the fetched CSV to the browser as a download. The object URL is revoked
 * immediately after the synthetic click — the download is already committed by then,
 * and leaving it un-revoked pins the whole file in memory for the life of the tab. */
function saveTextAsFile(text: string, filename: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Downloads one evidence export. A failure here is worth saying out loud — the
 * previous `<a download>` version failed by handing the user a file containing an
 * error body, or nothing at all, with no indication either had happened. */
export function useDownloadExport() {
  return useMutation({
    mutationFn: async (target: AuditExport) => {
      const csv = await apiGetText(target.path);
      saveTextAsFile(csv, target.filename, "text/csv;charset=utf-8");
    },
    onError: (error, target) => {
      toast.error(`Couldn't download the ${target.label.toLowerCase()} export`, {
        description: error.message,
      });
    },
  });
}

/** Domain-first query key tuples. */
export const auditKeys = {
  all: ["audit"] as const,
  timeline: () => [...auditKeys.all, "timeline"] as const,
  /** Deliberately under `timeline()`'s prefix: anything that already
   * invalidates the org timeline invalidates the per-machine feeds too,
   * since they read the same events. */
  machineTimeline: (machineId: string) => [...auditKeys.timeline(), "machine", machineId] as const,
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

function toTimelineEntry(e: EvidenceRecordWire): AuditTimelineEntry {
  return {
    id: e.id,
    type: e.type,
    occurredAt: e.occurredAt,
    recordedAt: e.recordedAt,
    actorType: e.actor.type,
    actorId: e.actor.id,
    machineId: e.machineId ?? undefined,
    summary: e.summary,
  };
}

async function fetchAuditTimeline(): Promise<AuditTimelineEntry[]> {
  const res = await apiGet<{ data: EvidenceRecordWire[] }>("/api/v1/evidence?limit=100");
  return res.data.map(toTimelineEntry);
}

/** One page of the evidence feed, cursor and all. `fetchAuditTimeline` above
 * throws `pageInfo` away because the views on it show a fixed newest-100 and
 * never page; the machine Activity tab does page, so this keeps it. */
export interface AuditTimelinePage {
  entries: AuditTimelineEntry[];
  nextCursor: string | null;
}

async function fetchEvidencePage(params: {
  machineId?: string;
  cursor?: string | undefined;
  limit: number;
}): Promise<AuditTimelinePage> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.machineId) query.set("machineId", params.machineId);
  if (params.cursor) query.set("cursor", params.cursor);

  const res = await apiGet<{
    data: EvidenceRecordWire[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }>(`/api/v1/evidence?${query.toString()}`);

  return {
    entries: res.data.map(toTimelineEntry),
    // `hasMore` isn't carried separately — a null cursor already means "no more",
    // and two sources of truth for the same fact drift apart.
    nextCursor: res.pageInfo.hasMore ? res.pageInfo.nextCursor : null,
  };
}

/** How many events the Activity tab pulls per request. The server clamps to
 * 100; 50 keeps the first paint light while still covering most machines'
 * whole history in one go. */
export const MACHINE_ACTIVITY_PAGE_SIZE = 50;

/**
 * A single machine's own events, newest first, paged on demand.
 *
 * Filtered server-side by `machineId` rather than pulled from the org-wide
 * timeline and narrowed in the browser: on an org with several machines, most
 * of any org-wide page belongs to other machines, so client-side narrowing
 * showed an arbitrary slice of this machine's history.
 */
export function useMachineActivity(machineId: string) {
  return useInfiniteQuery({
    queryKey: auditKeys.machineTimeline(machineId),
    queryFn: ({ pageParam }) =>
      fetchEvidencePage({
        machineId,
        cursor: pageParam,
        limit: MACHINE_ACTIVITY_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditTimelinePage) => last.nextCursor ?? undefined,
  });
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
  const [controlMap, findingsRes] = await Promise.all([
    apiGet<{ controls: ControlMapEntryWire[] }>("/api/v1/compliance/control-map"),
    apiGet<{ checks: ComplianceCheckResultWire[] }>("/api/v1/compliance/findings"),
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
    "/api/v1/compliance/findings",
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
