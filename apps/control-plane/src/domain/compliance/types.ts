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
 * The check abstraction every compliance-check feature unit implements
 * against. "Compliance checks", never "tests" (CLAUDE.md terminology).
 */
export interface ComplianceCheck {
  id: string;
  label: string;
  appliesTo: (ctx: { orgId: string; machineId?: string }) => Effect.Effect<boolean>;
  evaluate: (ctx: { orgId: string }) => Effect.Effect<ComplianceFinding[], never, Db>;
  /** Framework control ids this check evidences. */
  controlRefs: string[];
}
