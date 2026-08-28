import type { PageInfo, PaginatedRequest } from "../common";

/**
 * Wire types for the generic approval object (spec §13). One approval gates
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

/** Request body for `POST /api/v1/approvals`. */
export interface CreateApprovalRequest {
  orgId: string;
  actionType: ApprovalActionType;
  requestedByPersonId: string;
  /** Null for actions that do not target a specific machine. */
  targetMachineId: string | null;
  /** Required free text — never optional (spec §13). */
  reason: string;
}

/** Request body for `POST /api/v1/approvals/:id/decide`. */
export interface DecideApprovalRequest {
  /**
   * The identified person recording this decision. A confirmation dialog is
   * self-approval and is not an approval — this must be a real person, not
   * an implicit UI confirmation (spec §13).
   */
  personId: string;
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
  orgId?: string;
}

export interface ListApprovalsResponse {
  items: ApprovalResource[];
  pageInfo: PageInfo;
}
