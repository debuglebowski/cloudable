// Wire types for /api/v1/archive/* — shared directly from source by the CLI (no
// generation step). Runtime validation schemas live alongside the
// HTTP routes in `apps/control-plane/src/http/routes/archive.ts`; these plain types are
// kept in sync with those schemas by hand.

import type { ApprovalStatus } from "./approvals";

export type { ApprovalStatus };
export type RestoreMode = "data" | "config" | "full";
export type SnapshotTrigger = "archive" | "upgrade" | "manual";
/**
 * Whether a snapshot's data can be restored, and if not, why not.
 *
 * - `restorable` — real disks were captured and retention has not elapsed.
 * - `expired` — the data existed and its retention window elapsed.
 * - `empty` — the provider copied nothing, so there is no data and never was. Every
 *   snapshot written before `createSnapshot` called a provider is in this state.
 *
 * `empty` was added because the first two were derived from `expiredAt` alone, so a
 * snapshot that captured nothing displayed as `restorable` with a working Restore
 * button. Additive to the union; consumers that only knew the first two treat an
 * unknown value as not-restorable, which is the safe direction.
 */
export type SnapshotSubState = "restorable" | "expired" | "empty" | "data_missing";

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

/** What a restore lands on. A union, not optional fields: restoring into a new machine and
 * overwriting an existing one are different operations with different blast radii. */
export type RestoreTarget =
  | {
      kind: "new_machine";
      /** Required, and never inferred from the snapshot's original machine — a common
       * restore recovers an offboarded person's data, and that former owner is exactly
       * who should not receive the new machine. */
      ownerPersonId: string;
      name?: string | undefined;
    }
  | {
      kind: "existing_machine";
      machineId: string;
      /** Required, and must be `true`, when the target still has a data disk to lose —
       * i.e. any state but archived. Never defaulted. */
      confirmDestroysData?: boolean | undefined;
    };

export interface RestoreSnapshotRequest {
  mode: RestoreMode;
  target: RestoreTarget;
  reason: string;
  /** Required, and must be `true`, when `mode` is `"full"` — an explicit
   * acknowledgement that secret bindings will be reattached. Never defaulted. */
  confirmSecretBindings?: boolean | undefined;
}

export interface RestoreSnapshotResponse {
  snapshotId: string;
  /** Null only while a new-machine restore is pending approval: the machine is not created
   * until the restore that creates it has been approved. */
  targetMachineId: string | null;
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
