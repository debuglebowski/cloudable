/**
 * Wire types for `/api/v1/compliance/*`. Plain TS types only (no schema
 * library dependency here — see `common.ts`); the control plane's HTTP
 * layer defines its own runtime `Schema.Struct`s shaped to match these and
 * is responsible for keeping them in sync.
 */

export type ComplianceCheckStatus = "pass" | "fail" | "not_applicable";

/**
 * How much a failure of this check should matter to an auditor. Fixed per
 * check (the control plane's `ComplianceCheck.severity` — see
 * `apps/control-plane/src/domain/compliance/types.ts`), not per finding —
 * every finding under the same check shares it. This is the one source of
 * truth for severity; consumers (e.g. the console) read it from here rather
 * than keeping their own classification.
 */
export type ComplianceFindingSeverity = "low" | "medium" | "high";

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
  severity: ComplianceFindingSeverity;
  /** Empty when `status` is `"pass"` or `"not_applicable"`. */
  findings: ComplianceFindingDto[];
  /**
   * Median `ageDays` across `findings` — surface
   * median age and trend, not just the current count. `null` when
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
  /** Framework clause this control maps to (e.g. "ISO 27001 A.9"). Placeholder mapping. */
  framework: string;
  status: ControlStatus;
  /** Ids of registered checks (see `COMPLIANCE_CHECKS`) that evidence this control. Empty unless `status` is `"implemented"`. */
  evidencedByCheckIds: string[];
  /** True when `status` came from this org's explicit override (`PATCH .../control-map/:controlId/override`) rather than the computed default. */
  overridden: boolean;
  /** True when this control is eligible for an override at all — false for a structurally
   * out-of-scope control, which `PATCH .../override` always rejects. */
  overridable: boolean;
}

export interface ControlMapResponse {
  controls: ControlMapEntry[];
}

/** `PATCH /api/v1/compliance/control-map/:controlId/override` payload. `status: null` clears
 * this org's override, reverting the control to its computed default. */
export interface SetControlOverridePayload {
  orgId: string;
  status: ControlStatus | null;
}
