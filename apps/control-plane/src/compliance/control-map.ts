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
 * Cloudable's own default control taxonomy — the controls it is itself
 * audited against: access management and asset management. This is the
 * DEFAULT only — an org can override a specific control's status on top of
 * it (see `applyControlOverrides` below); it never replaces this computation.
 *
 * `id` is exactly the string checks put in
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
 * Controls explicitly out of scope for this product — most of ISO Annex A
 * (physical security, HR screening, supplier contracts) has no bearing on
 * the product and must not be claimed as evidenced. These always report
 * `not_covered`, regardless of what's
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
 * honest status of implemented / manual action required / not covered.
 * Pure and synchronous — status only depends on which
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

/**
 * Control ids an org is allowed to override — in-scope controls only.
 * Deliberately excludes `OUT_OF_SCOPE_CONTROLS`: docs/compliance.md is explicit that a
 * structurally-out-of-scope control (physical security, HR screening, supplier
 * contracts — "has no bearing on the product") "must not be claimed as evidenced,
 * however many checks get registered." An org-level override setting one to
 * `"implemented"` would read identically to Cloudable claiming automated evidence for
 * it, which the product must never do — so unlike the two in-scope controls, these
 * aren't overridable at all, not even by an org's own explicit choice. Used by
 * `control-overrides-store.ts` to reject an override attempt for a control id that
 * either doesn't exist or isn't eligible.
 */
export const OVERRIDABLE_CONTROL_IDS: ReadonlySet<string> = new Set(
  IN_SCOPE_CONTROLS.map((control) => control.id),
);

/** One org's explicit choice for a single control, loaded from the `control_overrides`
 * table (see `control-overrides-store.ts`). */
export interface ControlOverride {
  readonly controlId: string;
  readonly status: ControlStatus;
}

export interface ControlMapEntryWithOverride extends ControlMapEntry {
  /** True when `status` came from an org's explicit override rather than the computed default. */
  readonly overridden: boolean;
  /** True when this control is eligible for an org override at all (`OVERRIDABLE_CONTROL_IDS`
   * above) — always false for a structurally out-of-scope control. Callers (the console's
   * override UI) use this to avoid offering an action that `control-overrides-store.ts`
   * will always reject. */
  readonly overridable: boolean;
}

/**
 * Layers an org's explicit overrides on top of the computed default map —
 * organisation-level configuration, overridable per control, so customers
 * can adjust for their own framework or auditor. A control with no
 * override for this org keeps exactly the status
 * `computeControlMap` gave it — this never replaces that computation, it
 * only decorates its output. Pure: the caller loads `overrides` from the DB
 * for the current org (`loadControlOverrides` in `control-overrides-store.ts`).
 *
 * `evidencedByCheckIds` is cleared whenever an override moves a control away
 * from `"implemented"` — per this same file's `ControlMapEntry` contract
 * (mirrored in `packages/contracts/src/domains/compliance.ts`:
 * "Empty unless `status` is `implemented`"), that field means "registered
 * checks that back the CURRENT status", not "checks that happened to back
 * the computed default." Leaving the original list in place would have an
 * org's own "not covered"/"manual action required" override still showing
 * live automated-check evidence underneath it (the console's
 * `fetchControlEvidence` renders that list as evidence rows) — silently
 * contradicting the override the org just set. An override landing back on
 * `"implemented"` re-derives its own `evidencedByCheckIds` from the same
 * computed default entry, since only Cloudable's registered checks are a
 * legitimate source of automated evidence, override or not.
 */
export const applyControlOverrides = (
  map: readonly ControlMapEntry[],
  overrides: readonly ControlOverride[],
): ControlMapEntryWithOverride[] => {
  const statusByControlId = new Map(overrides.map((o) => [o.controlId, o.status] as const));
  return map.map((entry) => {
    const overridable = OVERRIDABLE_CONTROL_IDS.has(entry.id);
    const overrideStatus = statusByControlId.get(entry.id);
    if (overrideStatus === undefined) {
      return { ...entry, overridden: false, overridable };
    }
    return {
      ...entry,
      status: overrideStatus,
      evidencedByCheckIds: overrideStatus === "implemented" ? entry.evidencedByCheckIds : [],
      overridden: true,
      overridable,
    };
  });
};
