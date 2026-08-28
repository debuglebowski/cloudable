import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  COST_ESTIMATE_DISCLAIMER,
  type SnapshotRow,
  archiveMachine,
  clearLegalHold,
  estimateSnapshotCost,
  fetchLatestSnapshotForMachine,
  fetchSnapshot,
  getSnapshotSubState,
  restoreSnapshot,
  restoreUnavailableReason,
  setLegalHold,
} from "../../domain/archive";
import { Api } from "../api";

const toSnapshotView = (snapshot: SnapshotRow) => ({
  id: snapshot.id,
  orgId: snapshot.orgId,
  machineId: snapshot.machineId,
  trigger: snapshot.trigger,
  region: snapshot.region,
  sizeBytes: snapshot.sizeBytes,
  containsData: snapshot.containsData,
  containsConfig: snapshot.containsConfig,
  legalHold: snapshot.legalHold,
  legalHoldReason: snapshot.legalHoldReason,
  retentionDays: snapshot.retentionDays,
  createdAt: snapshot.createdAt.toISOString(),
  expiresAt: snapshot.expiresAt.toISOString(),
  expiredAt: snapshot.expiredAt ? snapshot.expiredAt.toISOString() : null,
  subState: getSnapshotSubState(snapshot),
  restoreUnavailableReason: restoreUnavailableReason(snapshot),
});

const toLegalHoldResponse = (snapshot: SnapshotRow) => ({
  snapshotId: snapshot.id,
  legalHold: snapshot.legalHold,
  legalHoldReason: snapshot.legalHoldReason,
});

export const ArchiveLive = HttpApiBuilder.group(Api, "archive", (handlers) =>
  handlers
    .handle("archiveMachine", ({ path, payload }) =>
      archiveMachine(path.machineId, payload.approvalId).pipe(
        // `ProvisioningError`/`ArchiveDbError` are our own infra breaking, not a
        // meaningful outcome for an API caller — only `MachineNotFoundError` (declared
        // via `.addError` in ../routes/archive.ts) is a real 4xx here.
        Effect.catchTags({
          ProvisioningError: (e) => Effect.die(e),
          ArchiveDbError: (e) => Effect.die(e),
        }),
        Effect.flatMap(() => fetchLatestSnapshotForMachine(path.machineId, "archive")),
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map((snapshot) => ({
          machineId: path.machineId,
          state: "archived_restorable" as const,
          snapshotId: snapshot.id,
          retentionExpiresAt: snapshot.expiresAt.toISOString(),
        })),
      ),
    )
    .handle("restoreSnapshot", ({ path, payload }) =>
      restoreSnapshot({
        snapshotId: path.snapshotId,
        mode: payload.mode,
        targetMachineId: payload.targetMachineId,
        requestedByPersonId: payload.requestedByPersonId,
        reason: payload.reason,
        confirmSecretBindings: payload.confirmSecretBindings,
      }).pipe(
        Effect.catchTags({
          ArchiveDbError: (e) => Effect.die(e),
          ApprovalRequestFailedError: (e) => Effect.die(e),
        }),
      ),
    )
    .handle("setLegalHold", ({ path, payload }) =>
      setLegalHold(path.snapshotId, payload.reason).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map(toLegalHoldResponse),
      ),
    )
    .handle("clearLegalHold", ({ path, payload }) =>
      clearLegalHold(path.snapshotId, payload.reason).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map(toLegalHoldResponse),
      ),
    )
    .handle("getSnapshot", ({ path }) =>
      fetchSnapshot(path.snapshotId).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map(toSnapshotView),
      ),
    )
    .handle("getSnapshotCostEstimate", ({ path }) =>
      fetchSnapshot(path.snapshotId).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map((snapshot) => ({
          snapshotId: snapshot.id,
          estimatedCostUsd: estimateSnapshotCost(snapshot),
          currency: "USD" as const,
          disclaimer: COST_ESTIMATE_DISCLAIMER,
        })),
      ),
    ),
);
