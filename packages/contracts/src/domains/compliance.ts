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
