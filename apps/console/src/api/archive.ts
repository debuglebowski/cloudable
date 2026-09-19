import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError, apiGet, apiPost } from "@/lib/api-client";
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
/** Mirrors `resolveRestoreApprovalFloor`'s target axis: overwriting a machine that is
 * still running is always dual, whatever the mode or the org's own policy. */
export const RESTORE_TARGET_APPROVAL_FLOOR = "dual" as const;

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
  /** `null` for a machine whose provider has no region concept (docker/fake). */
  region: string | null;
  sizeBytes: number;
  usedBytes: number | null;
  scope: "full" | "shallow";
  capturedDiskCount: number;
  createdAt: string;
  retentionDays: number;
  expiresAt: string;
  /** Set once the volume data has been hard-deleted past `expiresAt`. Record persists regardless. */
  expiredAt: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  /** Computed server-side (`domain/archive/sub-state.ts`). Carried through rather than
   * re-derived from `expiredAt` here: the server knows about `"empty"` — a snapshot that
   * captured nothing — and a console deriving its own answer would show a working
   * Restore button over one. A value this console does not recognise must be treated as
   * NOT restorable, which is the safe direction. */
  subState: "restorable" | "expired" | "empty" | "data_missing";
  /** Null when the snapshot is usable. When set, actions that need the data must be
   * greyed out WITH this shown — never hidden (`sub-state.ts`). */
  restoreUnavailableReason: string | null;
}

export const archiveKeys = {
  all: ["archive"] as const,
  snapshots: () => [...archiveKeys.all, "snapshots"] as const,
};

interface SnapshotViewWire {
  id: string;
  orgId: string;
  machineId: string;
  trigger: SnapshotTrigger;
  region: string | null;
  sizeBytes: number | null;
  usedBytes: number | null;
  scope: "full" | "shallow";
  capturedDiskCount: number;
  containsData: boolean;
  containsConfig: boolean;
  legalHold: boolean;
  legalHoldReason: string | null;
  retentionDays: number;
  createdAt: string;
  expiresAt: string;
  expiredAt: string | null;
  subState: "restorable" | "expired" | "empty" | "data_missing";
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
    usedBytes: s.usedBytes ?? null,
    scope: s.scope,
    capturedDiskCount: s.capturedDiskCount ?? 0,
    createdAt: s.createdAt,
    retentionDays: s.retentionDays,
    expiresAt: s.expiresAt,
    expiredAt: s.expiredAt,
    legalHold: s.legalHold,
    legalHoldReason: s.legalHoldReason,
    subState: s.subState,
    restoreUnavailableReason: s.restoreUnavailableReason,
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

/** What the restore lands on — mirrors `RestoreTarget` in
 * `apps/control-plane/src/domain/archive/restore.ts`. */
export type RestoreTarget =
  | { kind: "new_machine"; ownerPersonId: string; name?: string }
  | { kind: "existing_machine"; machineId: string; confirmDestroysData?: boolean };

export interface RestoreSnapshotInput {
  snapshotId: string;
  mode: RestoreMode;
  target: RestoreTarget;
  /** Every restore is backed by an approval object — reason is "required free text, never
   * optional" — the real endpoint rejects an empty reason regardless of mode. */
  reason: string;
}

interface RestoreSnapshotResponseWire {
  snapshotId: string;
  /** Null while a new-machine restore is pending: the machine is not created until the
   * restore that creates it is approved. */
  targetMachineId: string | null;
  mode: RestoreMode;
  approvalId: string;
  approvalStatus: "pending" | "approved" | "rejected" | "expired";
  restored: boolean;
}

export function useRestoreSnapshot() {
  return useMutation({
    // The target comes from the caller now. It used to be derived here — always the
    // machine the snapshot was taken from — which quietly made every restore the
    // destructive kind, with no way to ask for anything else.
    mutationFn: async (input: RestoreSnapshotInput) =>
      apiPost<RestoreSnapshotResponseWire>(
        `/api/v1/archive/snapshots/${input.snapshotId}/restore`,
        {
          mode: input.mode,
          target: input.target,
          reason: input.reason,
          ...(input.mode === "full" ? { confirmSecretBindings: true } : {}),
        },
      ),
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

export interface OpenInspectionResponse {
  sessionId: string;
  snapshotId: string;
  machineId: string;
  /** Where the browser should open — the machine's home directory, not the disk root. */
  rootPath: string;
  expiresAt: string;
}

/**
 * Opens a read-only inspection of a snapshot's persistent disk.
 *
 * Whether the caller is allowed is the server's decision and only the server's: they own
 * the machine, or they hold a granted elevation on it. Nothing here predicts that — the
 * same rule `browse-files-dialog.tsx` states for live file sessions, and it matters more
 * here, because a button that guessed wrong in the permissive direction would be guessing
 * about a departed person's home directory.
 */
export function useOpenSnapshotInspection() {
  return useMutation({
    mutationFn: (snapshotId: string) =>
      apiPost<OpenInspectionResponse>(`/api/v1/archive/snapshots/${snapshotId}/inspections`),
    onError: (error) => {
      // The server's `reason` is the whole point of refusing with one — it says to request
      // elevated access, and for an offboarded machine that it has no owner to ask. The
      // generic `error.message` is "POST /api/v1/... -> 403", because these errors carry
      // `reason` rather than the `message` field `ApiError` knows to lift. Reading the
      // body directly is what `api-client.ts` tells callers who need the structured reason
      // to do.
      toast.error("Can't open this snapshot", { description: reasonOf(error) });
    },
  });
}

/** The `reason` off a tagged domain error body, falling back to the generic message. */
function reasonOf(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const reason = (error.body as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return error instanceof Error ? error.message : String(error);
}
