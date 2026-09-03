import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api-client";
import { listMachines } from "./machines";

/**
 * Restore modes, escalating approval: data < config < full including secret
 * bindings (deliberately hardest to reach). Mirrors
 * `SnapshotEvent["snapshot.restored"].payload.mode` in
 * `packages/events/src/domains/snapshot.ts`.
 */
export type RestoreMode = "data" | "config" | "full";

/**
 * The MINIMUM approval mode the control plane structurally guarantees per restore mode —
 * mirrors `resolveRestoreApprovalFloor` in
 * `apps/control-plane/src/domain/archive/approval-escalation.ts`, enforced there via
 * `ApprovalService.request()`'s `requiredModeFloor` (clamped up, never satisfiable by a
 * weaker org-configured `approval_mode:snapshot_restore` setting). This is a FLOOR, not
 * the exact mode that will apply: `"data"` has no floor at all, so its actual approval
 * mode is whatever the org has configured (which may well be stricter than `"none"`);
 * `"config"` is guaranteed to be at least `"single"` but could be `"dual"` if the org
 * configured that; `"full"` is the only mode with an exact, unconditional guarantee —
 * always `"dual"`, regardless of org configuration.
 */
export const RESTORE_MODE_APPROVAL: Record<RestoreMode, "none" | "single" | "dual"> = {
  data: "none",
  config: "single",
  full: "dual",
};

/** Mirrors `snapshots.trigger` (`packages/schema/src/tables/snapshot.ts`) — `"archive"` is the
 * final snapshot `archiveMachine()` takes; `"upgrade"`/`"manual"` snapshots can exist against a
 * still-live machine, which is why a machine's snapshot history isn't 1:1 with its archive state. */
export type SnapshotTrigger = "archive" | "upgrade" | "manual";

/** One snapshot row — org-wide, not archived-machines-only (see `SnapshotTrigger`). Consumed by
 * the Archive page (governance: retention/legal hold, filtered to `trigger === "archive"`) and by
 * a machine's own Snapshots tab (that machine's full history, every trigger). */
export interface ArchivedSnapshot {
  id: string;
  machineId: string;
  machineName: string;
  trigger: SnapshotTrigger;
  region: string;
  sizeBytes: number;
  createdAt: string;
  retentionDays: number;
  expiresAt: string;
  /** Set once the volume data has been hard-deleted past `expiresAt`. Record persists regardless. */
  expiredAt: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  /** Estimated Azure snapshot storage cost for the retention window — an estimate, never a bill. */
  projectedCostUsd: number;
}

export const archiveKeys = {
  all: ["archive"] as const,
  snapshots: () => [...archiveKeys.all, "snapshots"] as const,
};

// Placeholder Azure managed-disk snapshot storage rate (Standard HDD, per GB-month). The real
// backend has its own cost-estimate endpoint (GET .../cost-estimate) with the same disclaimer
// contract — not called here since the Archive page shows every snapshot's estimate inline in
// one table render rather than one request per row; swap to that endpoint if per-row accuracy
// (it accounts for containsData/containsConfig) matters more than one request per page load.
const ESTIMATED_USD_PER_GB_MONTH = 0.05;

function estimateProjectedCostUsd(sizeBytes: number | null, retentionDays: number): number {
  const gb = (sizeBytes ?? 0) / 1_000_000_000;
  const months = retentionDays / 30;
  return Math.round(gb * ESTIMATED_USD_PER_GB_MONTH * months * 100) / 100;
}

interface SnapshotViewWire {
  id: string;
  orgId: string;
  machineId: string;
  trigger: SnapshotTrigger;
  region: string;
  sizeBytes: number | null;
  containsData: boolean;
  containsConfig: boolean;
  legalHold: boolean;
  legalHoldReason: string | null;
  retentionDays: number;
  createdAt: string;
  expiresAt: string;
  expiredAt: string | null;
  subState: "restorable" | "expired";
  restoreUnavailableReason: string | null;
}

export async function fetchArchivedSnapshots(): Promise<ArchivedSnapshot[]> {
  const [res, machines] = await Promise.all([
    apiGet<{ items: SnapshotViewWire[] }>("/api/v1/archive/snapshots"),
    listMachines(),
  ]);
  return res.items.map((s) => ({
    id: s.id,
    machineId: s.machineId,
    machineName: machines.find((m) => m.id === s.machineId)?.name ?? s.machineId,
    trigger: s.trigger,
    region: s.region,
    sizeBytes: s.sizeBytes ?? 0,
    createdAt: s.createdAt,
    retentionDays: s.retentionDays,
    expiresAt: s.expiresAt,
    expiredAt: s.expiredAt,
    legalHold: s.legalHold,
    legalHoldReason: s.legalHoldReason,
    projectedCostUsd: estimateProjectedCostUsd(s.sizeBytes, s.retentionDays),
  }));
}

export function useArchivedSnapshots() {
  return useQuery({
    queryKey: archiveKeys.snapshots(),
    queryFn: fetchArchivedSnapshots,
  });
}

/** One machine's full snapshot history (every trigger), sharing `useArchivedSnapshots()`'s
 * cache entry via `select` rather than issuing a second fetch — backs a machine's Snapshots tab. */
export function useMachineSnapshots(machineId: string) {
  return useQuery({
    queryKey: archiveKeys.snapshots(),
    queryFn: fetchArchivedSnapshots,
    select: (snapshots) => snapshots.filter((s) => s.machineId === machineId),
  });
}

export interface SetLegalHoldInput {
  snapshotId: string;
  legalHold: boolean;
  /** Required free text either way — feeds `snapshot.legal_hold_set` / `snapshot.legal_hold_cleared`. */
  reason: string;
}

export function useSetLegalHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetLegalHoldInput) => {
      const path = input.legalHold
        ? `/api/v1/archive/snapshots/${input.snapshotId}/legal-hold`
        : `/api/v1/archive/snapshots/${input.snapshotId}/legal-hold/clear`;
      await apiPost(path, { reason: input.reason });
      return input;
    },
    onSuccess: (input) => {
      void queryClient.invalidateQueries({ queryKey: archiveKeys.snapshots() });
      toast.success(input.legalHold ? "Legal hold placed" : "Legal hold removed");
    },
    onError: (error) => {
      toast.error("Couldn't update legal hold", { description: error.message });
    },
  });
}

export interface RestoreSnapshotInput {
  snapshotId: string;
  mode: RestoreMode;
  /** Every restore is backed by an approval object — reason is "required free text, never
   * optional" — the real endpoint rejects an empty reason regardless of mode. */
  reason: string;
}

interface RestoreSnapshotResponseWire {
  snapshotId: string;
  targetMachineId: string;
  mode: RestoreMode;
  approvalId: string;
  approvalStatus: "pending" | "approved" | "rejected" | "expired";
  restored: boolean;
}

export function useRestoreSnapshot() {
  return useMutation({
    mutationFn: async (input: RestoreSnapshotInput) => {
      const snapshots = await fetchArchivedSnapshots();
      const snapshot = snapshots.find((s) => s.id === input.snapshotId);
      if (!snapshot) throw new Error(`Snapshot ${input.snapshotId} not found`);
      return apiPost<RestoreSnapshotResponseWire>(
        `/api/v1/archive/snapshots/${input.snapshotId}/restore`,
        {
          mode: input.mode,
          // Restoring onto the same machine record the snapshot was taken from — the
          // dialog has no "restore to a different machine" picker, and that's the
          // common case (disposable machines, reimage-in-place).
          targetMachineId: snapshot.machineId,
          reason: input.reason,
          ...(input.mode === "full" ? { confirmSecretBindings: true } : {}),
        },
      );
    },
    onSuccess: (result) => {
      toast.success(
        result.approvalStatus === "approved" && result.restored
          ? "Restore started"
          : "Restore requested — awaiting approval",
      );
    },
    onError: (error) => {
      toast.error("Couldn't start restore", { description: error.message });
    },
  });
}
