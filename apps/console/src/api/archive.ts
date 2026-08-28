import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Restore modes, escalating approval (spec §14): data (default, no approval) <
 * config (single approval) < full including secret bindings (dual approval,
 * deliberately hardest to reach). Mirrors `SnapshotEvent["snapshot.restored"].payload.mode`
 * in `packages/events/src/domains/snapshot.ts`.
 */
export type RestoreMode = "data" | "config" | "full";

export const RESTORE_MODE_APPROVAL: Record<RestoreMode, "none" | "single" | "dual"> = {
  data: "none",
  config: "single",
  full: "dual",
};

/** One archived machine's snapshot row, as the Archive page renders it. */
export interface ArchivedSnapshot {
  id: string;
  machineId: string;
  machineName: string;
  region: string;
  sizeBytes: number;
  /** `snapshots.createdAt` — when the snapshot (and archival) happened. */
  archivedAt: string;
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

// Placeholder Azure managed-disk snapshot storage rate (Standard HDD, per GB-month). Swap for a
// real control-plane cost figure once one exists — this is only ever surfaced as an estimate.
const ESTIMATED_USD_PER_GB_MONTH = 0.05;

function estimateProjectedCostUsd(sizeBytes: number, retentionDays: number): number {
  const gb = sizeBytes / 1_000_000_000;
  const months = retentionDays / 30;
  return Math.round(gb * ESTIMATED_USD_PER_GB_MONTH * months * 100) / 100;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * GET /archive/snapshots does not exist yet — unit 15's archive/restore endpoints are an open,
 * not-yet-merged PR against `main`, and this branch forks from bootstrap-only `main`. Until that
 * lands, this hook serves realistic mock data covering both archived sub-states (spec §14):
 * restorable (with and without legal hold, one near its retention deadline) and expired (data
 * hard-deleted, record retained). Swap the `queryFn` body for
 * `apiGet<ArchivedSnapshot[]>("/archive/snapshots")` once the endpoint exists.
 */
function loadMockSnapshots(): ArchivedSnapshot[] {
  const rows: Array<Omit<ArchivedSnapshot, "projectedCostUsd">> = [
    {
      id: "snap-001",
      machineId: "machine-001",
      machineName: "web-prod-01",
      region: "eastus",
      sizeBytes: 42_000_000_000,
      archivedAt: daysAgo(5),
      retentionDays: 30,
      expiresAt: daysFromNow(25),
      expiredAt: null,
      legalHold: false,
      legalHoldReason: null,
    },
    {
      id: "snap-002",
      machineId: "machine-002",
      machineName: "db-shadow-02",
      region: "westeurope",
      sizeBytes: 120_000_000_000,
      archivedAt: daysAgo(27),
      retentionDays: 30,
      expiresAt: daysFromNow(3),
      expiredAt: null,
      legalHold: false,
      legalHoldReason: null,
    },
    {
      id: "snap-003",
      machineId: "machine-003",
      machineName: "finance-archive-03",
      region: "eastus",
      sizeBytes: 8_000_000_000,
      archivedAt: daysAgo(40),
      retentionDays: 30,
      expiresAt: daysAgo(10),
      expiredAt: null,
      legalHold: true,
      legalHoldReason: "Litigation hold — Doe v. Acme, case #4471 (Legal)",
    },
    {
      id: "snap-004",
      machineId: "machine-004",
      machineName: "temp-build-04",
      region: "westus2",
      sizeBytes: 15_000_000_000,
      archivedAt: daysAgo(65),
      retentionDays: 30,
      expiresAt: daysAgo(35),
      expiredAt: daysAgo(35),
      legalHold: false,
      legalHoldReason: null,
    },
    {
      id: "snap-005",
      machineId: "machine-005",
      machineName: "batch-worker-05",
      region: "eastus",
      sizeBytes: 5_000_000_000,
      archivedAt: daysAgo(1),
      retentionDays: 30,
      expiresAt: daysFromNow(29),
      expiredAt: null,
      legalHold: false,
      legalHoldReason: null,
    },
  ];

  return rows.map((row) => ({
    ...row,
    projectedCostUsd: estimateProjectedCostUsd(row.sizeBytes, row.retentionDays),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useArchivedSnapshots() {
  return useQuery({
    queryKey: archiveKeys.snapshots(),
    queryFn: async () => {
      await sleep(150);
      return loadMockSnapshots();
    },
  });
}

export interface SetLegalHoldInput {
  snapshotId: string;
  legalHold: boolean;
  /** Required free text either way — feeds `snapshot.legal_hold_set` / `snapshot.legal_hold_cleared`. */
  reason: string;
}

/**
 * Mocked until unit 15's endpoints land (see `useArchivedSnapshots`). Would be
 * `apiPost(`/archive/snapshots/${snapshotId}/legal-hold`, { legalHold, reason })`.
 */
export function useSetLegalHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetLegalHoldInput) => {
      await sleep(300);
      return input;
    },
    onSuccess: (input) => {
      queryClient.setQueryData<ArchivedSnapshot[]>(archiveKeys.snapshots(), (prev) =>
        prev?.map((snapshot) =>
          snapshot.id === input.snapshotId
            ? {
                ...snapshot,
                legalHold: input.legalHold,
                legalHoldReason: input.legalHold ? input.reason : null,
              }
            : snapshot,
        ),
      );
    },
  });
}

export interface RestoreSnapshotInput {
  snapshotId: string;
  mode: RestoreMode;
  /** Required for config/full; data-only carries no approval gate so no reason is collected. */
  reason: string;
}

/**
 * Mocked until unit 15's endpoints land (see `useArchivedSnapshots`). Would be
 * `apiPost(`/archive/snapshots/${snapshotId}/restore`, { mode, reason })`, gated server-side by
 * the approval mode in `RESTORE_MODE_APPROVAL` and writing `snapshot.restored`.
 */
export function useRestoreSnapshot() {
  return useMutation({
    mutationFn: async (input: RestoreSnapshotInput) => {
      await sleep(400);
      return input;
    },
  });
}
