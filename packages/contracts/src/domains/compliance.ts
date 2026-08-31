/**
 * Wire types for `/api/v1/compliance/*`. Plain TS types only (no schema
 * library dependency here — see `common.ts`); the control plane's HTTP
 * layer defines its own runtime `Schema.Struct`s shaped to match these and
 * is responsible for keeping them in sync.
 */

export type ComplianceCheckStatus = "pass" | "fail" | "not_applicable";

export interface ComplianceFindingDto {
  machineId: string | null;
  /** ISO 8601 — when this finding was first observed as open. */
  firstSeenAt: string;
  ageDays: number;
  detail: Record<string, unknown>;
}

export interface ComplianceCheckResult {
  checkId: string;
  label: string;
  controlRefs: string[];
  status: ComplianceCheckStatus;
  /** Empty when `status` is `"pass"` or `"not_applicable"`. */
  findings: ComplianceFindingDto[];
  /**
   * Median `ageDays` across `findings` (spec §19 "Finding age": "surface
   * median age and trend ... not just the current count"). `null` when
   * `findings` is empty — there is no age distribution to summarize.
   */
  medianAgeDays: number | null;
}

export interface ComplianceFindingsResponse {
  orgId: string;
  /** ISO 8601 — when this response was computed. */
  generatedAt: string;
  checks: ComplianceCheckResult[];
}

export type ControlStatus = "implemented" | "manual_action_required" | "not_covered";

export interface ControlMapEntry {
  id: string;
  label: string;
  /** Framework clause this control maps to (e.g. "ISO 27001 A.9"). Placeholder mapping, org-overridable in a future release. */
  framework: string;
  status: ControlStatus;
  /** Ids of registered checks (see `COMPLIANCE_CHECKS`) that evidence this control. Empty unless `status` is `"implemented"`. */
  evidencedByCheckIds: string[];
}

export interface ControlMapResponse {
  controls: ControlMapEntry[];
}
