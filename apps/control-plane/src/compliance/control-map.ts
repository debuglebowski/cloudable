import { COMPLIANCE_CHECKS } from "./registry";

export type ControlStatus = "implemented" | "manual_action_required" | "not_covered";

export interface ControlDefinition {
  readonly id: string;
  readonly label: string;
  /** Framework clause this control maps to. Placeholder mapping — see docs/compliance.md. */
  readonly framework: string;
}

export interface ControlMapEntry extends ControlDefinition {
  readonly status: ControlStatus;
  readonly evidencedByCheckIds: readonly string[];
}

/** The subset of `ComplianceCheck` the control map needs — kept narrow so it's trivial to unit test. */
export interface CheckRef {
  readonly id: string;
  readonly controlRefs: readonly string[];
}

/**
 * Cloudable's own default control taxonomy (docs/spec.md §19: "Cloudable
 * ships defaults for the controls it is itself audited against — access
 * management and asset management clauses"). Org-level override of this
 * mapping is future work; v1 ships one global default.
 *
 * `id` is exactly the string feature-unit checks put in
 * `ComplianceCheck.controlRefs` — see `registry.ts` for what's actually
 * registered. A control here is "implemented" once *any* registered check
 * evidences it; otherwise Cloudable claims the control as in scope but has
 * nothing automated backing it yet, i.e. "manual action required".
 */
const IN_SCOPE_CONTROLS: readonly ControlDefinition[] = [
  { id: "access-management", label: "Access management", framework: "ISO 27001 A.9" },
  { id: "asset-management", label: "Asset management", framework: "ISO 27001 A.8" },
];

/**
 * Controls explicitly OUT of scope for this product (docs/spec.md §19:
 * "Most of ISO Annex A — physical security, HR screening, supplier
 * contracts — has no bearing on the product and must not be claimed as
 * evidenced"). These always report `not_covered`, regardless of what's
 * registered in `COMPLIANCE_CHECKS`: no check should ever claim one of
 * these ids in `controlRefs`, and this list does not derive from
 * `COMPLIANCE_CHECKS` at all.
 */
const OUT_OF_SCOPE_CONTROLS: readonly ControlDefinition[] = [
  { id: "hr-screening", label: "HR screening", framework: "ISO 27001 A.7" },
  {
    id: "physical-security",
    label: "Physical and environmental security",
    framework: "ISO 27001 A.11",
  },
  { id: "supplier-management", label: "Supplier relationships", framework: "ISO 27001 A.15" },
];

/**
 * Computes the control map: for every control Cloudable knows about, an
 * honest status of implemented / manual action required / not covered
 * (docs/spec.md §19). Pure and synchronous — status only depends on which
 * checks are currently registered, not on any org's live findings, so no
 * `Db`/`Effect` dependency is needed here.
 */
export const computeControlMap = (
  checks: readonly CheckRef[] = COMPLIANCE_CHECKS,
): ControlMapEntry[] => {
  const inScope = IN_SCOPE_CONTROLS.map((control): ControlMapEntry => {
    const evidencedByCheckIds = checks
      .filter((check) => check.controlRefs.includes(control.id))
      .map((check) => check.id);
    return {
      ...control,
      status: evidencedByCheckIds.length > 0 ? "implemented" : "manual_action_required",
      evidencedByCheckIds,
    };
  });

  const outOfScope = OUT_OF_SCOPE_CONTROLS.map(
    (control): ControlMapEntry => ({
      ...control,
      status: "not_covered",
      evidencedByCheckIds: [],
    }),
  );

  return [...inScope, ...outOfScope];
};
