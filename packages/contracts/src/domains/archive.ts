// Wire types for /api/v1/archive/* — shared directly from source by the CLI (no
// generation step). Runtime validation schemas live alongside the
// HTTP routes in `apps/control-plane/src/http/routes/archive.ts`; these plain types are
// kept in sync with those schemas by hand.

import type { ApprovalStatus } from "./approvals";

export type { ApprovalStatus };
export type RestoreMode = "data" | "config" | "full";
export type SnapshotTrigger = "archive" | "upgrade" | "manual";
export type SnapshotSubState = "restorable" | "expired";

export interface ArchiveMachineRequest {
  /** An approval already obtained elsewhere (e.g. by an offboarding flow). Archiving a
   * machine directly is not itself approval-gated in this build. */
  approvalId?: string;
}

export interface ArchiveMachineResponse {
  machineId: string;
  state: "archived_restorable";
  snapshotId: string;
  retentionExpiresAt: string;
}

export interface RestoreSnapshotRequest {
  mode: RestoreMode;
  targetMachineId: string;
  reason: string;
  /** Required, and must be `true`, when `mode` is `"full"` — an explicit
   * acknowledgement that secret bindings will be reattached. Never defaulted. */
  confirmSecretBindings?: boolean | undefined;
}

export interface RestoreSnapshotResponse {
  snapshotId: string;
  targetMachineId: string;
  mode: RestoreMode;
  approvalId: string;
  approvalStatus: ApprovalStatus;
  /** `true` only once the restore has actually happened — a `"pending"` status
   * (single/dual mode, awaiting a human decision) returns `false` here. */
  restored: boolean;
}

export interface SetLegalHoldRequest {
  reason: string;
}

export interface ClearLegalHoldRequest {
  reason: string;
}

export interface LegalHoldResponse {
  snapshotId: string;
  legalHold: boolean;
  legalHoldReason: string | null;
}

export interface SnapshotView {
  id: string;
  orgId: string;
  machineId: string;
  trigger: SnapshotTrigger;
  /** `null` for a machine whose provider has no region concept (docker/fake). */
  region: string | null;
  sizeBytes: number | null;
  containsData: boolean;
  containsConfig: boolean;
  legalHold: boolean;
  legalHoldReason: string | null;
  retentionDays: number;
  createdAt: string;
  expiresAt: string;
  expiredAt: string | null;
  subState: SnapshotSubState;
  /** `null` when `subState` is `"restorable"`. Restore must be greyed out WITH this
   * reason shown when set — never just hidden. */
  restoreUnavailableReason: string | null;
}

export interface SnapshotCostEstimateResponse {
  snapshotId: string;
  estimatedCostUsd: number;
  currency: "USD";
  /** Always shown next to the figure — this is a rough sizing estimate, never billing. */
  disclaimer: string;
}
