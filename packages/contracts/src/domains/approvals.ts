import type { PageInfo, PaginatedRequest } from "../common";

/**
 * Wire types for the generic approval object. One approval gates
 * one sensitive action — snapshot restore, break-glass, admin access to an
 * unowned machine, or offboarding.
 */
export type ApprovalActionType =
  | "snapshot_restore"
  | "break_glass"
  | "admin_access"
  | "offboarding";

/** Approval mode is policy, resolved per action type via `resolveSetting()`. */
export type ApprovalMode = "none" | "single" | "dual";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalDecisionValue = "approved" | "rejected";

// `orgId`/`requestedByPersonId`/`personId` are gone from every request
// below: the server derives both from the caller's session
// (`CurrentUserTag`), not the wire — see
// `apps/control-plane/src/http/middleware/auth.ts`. A confirmation dialog
// is self-approval and is not an approval — deriving the
// deciding person from the real session, not a client-supplied id, is
// what actually enforces that.

/** Request body for `POST /api/v1/approvals`. */
export interface CreateApprovalRequest {
  actionType: ApprovalActionType;
  /** Null for actions that do not target a specific machine. */
  targetMachineId: string | null;
  /** Required free text — never optional. */
  reason: string;
}

/** Request body for `POST /api/v1/approvals/:id/decide`. */
export interface DecideApprovalRequest {
  decision: ApprovalDecisionValue;
  /** Required when `decision` is "rejected" — denials are evidence. */
  reason?: string;
}

/** Wire shape of an approval, returned by request/decide/status/list. */
export interface ApprovalResource {
  id: string;
  orgId: string;
  actionType: ApprovalActionType;
  mode: ApprovalMode;
  status: ApprovalStatus;
  requestedByPersonId: string;
  targetMachineId: string | null;
  reason: string;
  /** 0 for "none" mode, 1 for "single", 2 for "dual". */
  requiredApprovals: number;
  /** Count of distinct "approved" decisions recorded so far. */
  approvedCount: number;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface ListApprovalsQuery extends PaginatedRequest {
  status?: ApprovalStatus;
}

export interface ListApprovalsResponse {
  items: ApprovalResource[];
  pageInfo: PageInfo;
}
