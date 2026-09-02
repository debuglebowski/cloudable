import { Effect } from "effect";
import type { Db } from "../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../domain/compliance/types";
import { COMPLIANCE_CHECKS } from "./registry";

export type CheckStatus = "pass" | "fail" | "not_applicable";

export interface CheckEvaluation {
  readonly check: ComplianceCheck;
  readonly status: CheckStatus;
  readonly findings: readonly ComplianceFinding[];
}

/**
 * Runs every registered check for `orgId`, applicability-gated: a check
 * whose `appliesTo` returns false is reported `not_applicable` rather than
 * evaluated. Dashboards full of `N/A` are avoided by gating correctly up
 * front — not by hiding the row.
 *
 * Iterates `checks` generically, so this works correctly regardless of how
 * many checks happen to be registered in `registry.ts` at any given time
 * (including zero, while other checks haven't merged yet).
 */
export const evaluateAllChecks = (
  orgId: string,
  checks: readonly ComplianceCheck[] = COMPLIANCE_CHECKS,
): Effect.Effect<CheckEvaluation[], never, Db> =>
  Effect.forEach(
    checks,
    (check) =>
      Effect.gen(function* () {
        const applies = yield* check.appliesTo({ orgId });
        if (!applies) {
          return { check, status: "not_applicable" as const, findings: [] };
        }
        const findings = yield* check.evaluate({ orgId });
        return {
          check,
          status: (findings.length === 0 ? "pass" : "fail") as CheckStatus,
          findings,
        };
      }),
    // Checks are independent, each doing its own DB round-trip — run them
    // concurrently so latency doesn't grow linearly as more get registered.
    { concurrency: "unbounded" },
  );
