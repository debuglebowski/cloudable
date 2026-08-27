import { Effect } from "effect";

export interface ApprovalRequest {
  orgId: string;
  actionType: "snapshot_restore" | "break_glass" | "admin_access" | "offboarding";
  requestedByPersonId: string;
  targetMachineId: string | null;
  reason: string;
}

export interface ApprovalResult {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface ApprovalDecision {
  approvalId: string;
  personId: string;
  decision: "approved" | "rejected";
}

/**
 * The generic approval object (single/dual-control gate for sensitive
 * actions). This is a business service with one eventual real
 * implementation, not a swappable port — so it's modeled directly as an
 * `Effect.Service`.
 *
 * STUB: every method fails with "not_implemented" — feature unit 5 replaces
 * this whole file's implementation (request/decide/status against the
 * `approvals` and `approval_decisions` tables, single vs. dual mode,
 * `approval.*` events).
 */
export class ApprovalService extends Effect.Service<ApprovalService>()("ApprovalService", {
  effect: Effect.gen(function* () {
    const request = (_req: ApprovalRequest): Effect.Effect<ApprovalResult, Error> =>
      Effect.fail(new Error("not_implemented — see unit 5"));

    const decide = (_decision: ApprovalDecision): Effect.Effect<ApprovalResult, Error> =>
      Effect.fail(new Error("not_implemented — see unit 5"));

    const status = (_approvalId: string): Effect.Effect<ApprovalResult, Error> =>
      Effect.fail(new Error("not_implemented — see unit 5"));

    return { request, decide, status } as const;
  }),
}) {}
