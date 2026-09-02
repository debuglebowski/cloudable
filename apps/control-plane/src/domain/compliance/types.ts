import type { Effect } from "effect";
import type { Db } from "../../db/layer";

export interface ComplianceFinding {
  checkId: string;
  orgId: string;
  machineId: string | null;
  firstSeenAt: Date;
  detail: Record<string, unknown>;
}

/**
 * How much a failure of this check should matter to an auditor. Fixed per
 * check, not per finding — every open finding under the same check shares
 * it (there is no finer-grained per-finding risk score, and inventing one
 * per finding would be fabricating a signal that doesn't exist). This is
 * the one place severity is defined: `evidence-export.ts`'s CSVs and the
 * `/api/v1/compliance/findings` response both read it off the check that
 * produced the finding, rather than each keeping their own classification.
 */
export type ComplianceSeverity = "low" | "medium" | "high";

/**
 * The check abstraction every compliance-check feature unit implements
 * against. "Compliance checks", never "tests" (CLAUDE.md terminology).
 */
export interface ComplianceCheck {
  id: string;
  label: string;
  /** Editorial classification of how much a failure of this check matters — see `ComplianceSeverity`. */
  severity: ComplianceSeverity;
  /**
   * A check is only asked where it makes sense — a real, data-backed predicate,
   * not a bare `true`. Requires `Db` (widened from an earlier version of this type that
   * didn't) precisely so a check can look up whether the org has ever produced the kind of
   * data this check is about, e.g. "has this org ever used break-glass access at all" —
   * without that, every check either runs unconditionally or has to fake applicability
   * inside `evaluate` itself (both real problems this type change closes).
   */
  appliesTo: (ctx: { orgId: string }) => Effect.Effect<boolean, never, Db>;
  evaluate: (ctx: { orgId: string }) => Effect.Effect<ComplianceFinding[], never, Db>;
  /** Framework control ids this check evidences. */
  controlRefs: string[];
}
