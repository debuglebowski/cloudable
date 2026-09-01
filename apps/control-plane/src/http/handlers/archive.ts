import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  COST_ESTIMATE_DISCLAIMER,
  type SnapshotRow,
  archiveMachine,
  clearLegalHold,
  estimateSnapshotCost,
  fetchLatestSnapshotForMachine,
  fetchMachine,
  fetchSnapshot,
  getSnapshotSubState,
  listSnapshotsByOrg,
  restoreSnapshot,
  restoreUnavailableReason,
  resumeRestore,
  setLegalHold,
} from "../../domain/archive";
import { TunnelRelay } from "../../tunnel/relay";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

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
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // `archiveMachine`'s own signature is exact and load-bearing (see
        // `domain/archive/archive.ts`) and doesn't take an `orgId` — this
        // scoped fetch is the tenant-ownership gate in front of it.
        yield* fetchMachine(path.machineId, currentUser.orgId);
        yield* archiveMachine(path.machineId, payload.approvalId);
        // Spec §8.2/§11.1: archiving a machine directly (not via offboarding) must also kill
        // any live terminal/SSH session on it, not just block new ones — same requirement
        // `domain/offboarding/offboardPerson.ts`'s own archive step now honors.
        const tunnelRelay = yield* TunnelRelay;
        yield* tunnelRelay.terminateSessionsForMachine({
          orgId: currentUser.orgId,
          machineId: path.machineId,
          reason: "policy_terminated",
        });
        const snapshot = yield* fetchLatestSnapshotForMachine(path.machineId, "archive");
        return {
          machineId: path.machineId,
          state: "archived_restorable" as const,
          snapshotId: snapshot.id,
          retentionExpiresAt: snapshot.expiresAt.toISOString(),
        };
      }).pipe(
        // `ProvisioningError`/`ArchiveDbError`/`TunnelError` are our own infra breaking, not a
        // meaningful outcome for an API caller — only `MachineNotFoundError` (declared
        // via `.addError` in ../routes/archive.ts) is a real 4xx here. A `TunnelError` here
        // would be unusual (the machine we just successfully archived has no sessions to
        // fail to terminate, in the common case), not a condition the caller could act on
        // differently than any other infra failure.
        Effect.catchTags({
          ProvisioningError: (e) => Effect.die(e),
          ArchiveDbError: (e) => Effect.die(e),
          TunnelError: (e) => Effect.die(e),
        }),
      ),
    )
    .handle("restoreSnapshot", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // Same scoped-fetch-then-act pattern as `archiveMachine` above —
        // `restoreSnapshot`'s own signature doesn't take an `orgId`.
        yield* fetchSnapshot(path.snapshotId, currentUser.orgId);
        return yield* restoreSnapshot({
          snapshotId: path.snapshotId,
          mode: payload.mode,
          targetMachineId: payload.targetMachineId,
          requestedByPersonId: currentUser.personId,
          reason: payload.reason,
          confirmSecretBindings: payload.confirmSecretBindings,
        });
      }).pipe(
        Effect.catchTags({
          ArchiveDbError: (e) => Effect.die(e),
          ApprovalRequestFailedError: (e) => Effect.die(e),
        }),
      ),
    )
    .handle("resumeRestore", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // `resumeRestore` scopes its own approval lookup to `orgId` — a
        // foreign or non-restore approval id comes back as
        // `InvalidRestoreApprovalError`, the same non-leaking shape used
        // everywhere else.
        return yield* resumeRestore(path.approvalId, currentUser.orgId);
      }).pipe(Effect.catchTag("ArchiveDbError", (e) => Effect.die(e))),
    )
    .handle("setLegalHold", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* setLegalHold(path.snapshotId, currentUser.orgId, payload.reason);
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map(toLegalHoldResponse),
      ),
    )
    .handle("clearLegalHold", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* clearLegalHold(path.snapshotId, currentUser.orgId, payload.reason);
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map(toLegalHoldResponse),
      ),
    )
    .handle("listSnapshots", ({ urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* listSnapshotsByOrg({
          orgId: currentUser.orgId,
          cursor: urlParams.cursor,
          limit: urlParams.limit,
        });
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map((result) => ({
          items: result.items.map(toSnapshotView),
          pageInfo: { nextCursor: result.nextCursor, hasMore: result.hasMore },
        })),
      ),
    )
    .handle("getSnapshot", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* fetchSnapshot(path.snapshotId, currentUser.orgId);
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.map(toSnapshotView),
      ),
    )
    .handle("getSnapshotCostEstimate", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* fetchSnapshot(path.snapshotId, currentUser.orgId);
      }).pipe(
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
