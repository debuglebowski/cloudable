import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  COST_ESTIMATE_DISCLAIMER,
  InspectionFileUnreadableError,
  type SnapshotRow,
  archiveMachine,
  clearLegalHold,
  closeInspection,
  createSnapshot,
  estimateSnapshotCost,
  fetchLatestSnapshotForMachine,
  fetchMachine,
  fetchSnapshot,
  getSnapshotSubState,
  inspectionFilesystem,
  listSnapshotsByOrg,
  openInspection,
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
  usedBytes: snapshot.usedBytes,
  scope: snapshot.scope,
  capturedDiskCount: Array.isArray(snapshot.capturedDisks) ? snapshot.capturedDisks.length : 0,
  containsData: snapshot.containsData,
  containsConfig: snapshot.containsConfig,
  legalHold: snapshot.legalHold,
  legalHoldReason: snapshot.legalHoldReason,
  retentionDays: snapshot.retentionDays,
  createdAt: snapshot.createdAt.toISOString(),
  expiresAt: snapshot.expiresAt.toISOString(),
  expiredAt: snapshot.expiredAt ? snapshot.expiredAt.toISOString() : null,
  dataMissingAt: snapshot.dataMissingAt ? snapshot.dataMissingAt.toISOString() : null,
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
        // Archiving a machine directly (not via offboarding) must also kill
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
          // Mapped field by field rather than passed through: the wire schema's optional
          // properties are `T | undefined`, and the domain's are genuinely absent. Under
          // `exactOptionalPropertyTypes` those are different types, and spreading an
          // explicit `undefined` into the union would defeat the point of modelling it as
          // one.
          target:
            payload.target.kind === "new_machine"
              ? {
                  kind: "new_machine" as const,
                  ownerPersonId: payload.target.ownerPersonId,
                  ...(payload.target.name === undefined ? {} : { name: payload.target.name }),
                }
              : {
                  kind: "existing_machine" as const,
                  machineId: payload.target.machineId,
                  ...(payload.target.confirmDestroysData === undefined
                    ? {}
                    : { confirmDestroysData: payload.target.confirmDestroysData }),
                },
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
    )
    .handle("takeSnapshot", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // The tenancy gate, same as every other machine-scoped action here:
        // `createSnapshot`'s own signature is load-bearing and takes no orgId.
        yield* fetchMachine(path.machineId, currentUser.orgId);
        const snapshot = yield* createSnapshot(path.machineId, "manual", undefined, undefined, {
          scope: payload.scope ?? "shallow",
          // Never true. See the route's own comment: stopping a running machine to take
          // a snapshot someone asked for is a worse surprise than a crash-consistent copy.
          quiesce: false,
        });
        return {
          snapshotId: snapshot.id,
          machineId: snapshot.machineId,
          scope: snapshot.scope,
          capturedDiskCount: snapshot.capturedDisks.length,
          sizeBytes: snapshot.sizeBytes,
          usedBytes: snapshot.usedBytes,
          expiresAt: snapshot.expiresAt.toISOString(),
        };
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.catchTag("ProvisioningError", (e) => Effect.die(e)),
      ),
    )
    .handle("openInspection", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const opened = yield* openInspection({
          snapshotId: path.snapshotId,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
        });
        return { ...opened, expiresAt: opened.expiresAt.toISOString() };
      }).pipe(Effect.catchTag("ArchiveDbError", (e) => Effect.die(e))),
    )
    .handle("closeInspection", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* closeInspection({
          sessionId: path.sessionId,
          orgId: currentUser.orgId,
          actor: { actorType: "person", actorId: currentUser.personId },
          reason: "person_ended",
        });
        // Closing a session that was already closed, or never existed for this caller,
        // reports success: the caller wanted it not open, and it is not open. A 404 here
        // would make a browser tab closing twice look like a failure.
        return { ok: true as const };
      }).pipe(Effect.catchTag("ArchiveDbError", (e) => Effect.die(e))),
    )
    .handle("inspectionList", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const filesystem = yield* inspectionFilesystem({
          sessionId: path.sessionId,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
        });
        return yield* Effect.promise(() => filesystem.list(urlParams.path));
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        // A provider failure is ours, not the caller's: the grant could not be taken or
        // the image could not be opened. Died on rather than wired as a reason code,
        // same as every other infrastructure failure in this group.
        Effect.catchTag("ProvisioningError", (e) => Effect.die(e)),
      ),
    )
    .handle("inspectionDownload", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const filesystem = yield* inspectionFilesystem({
          sessionId: path.sessionId,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
        });
        const { result, bytes } = yield* Effect.promise(() => filesystem.download(urlParams.path));
        if (!result.ok || !bytes) {
          return yield* Effect.fail(
            new InspectionFileUnreadableError({
              path: urlParams.path,
              reason: result.ok ? "io_error" : result.reason,
            }),
          );
        }
        return bytes;
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.catchTag("ProvisioningError", (e) => Effect.die(e)),
      ),
    )
    .handle("inspectionRead", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const filesystem = yield* inspectionFilesystem({
          sessionId: path.sessionId,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
        });
        return yield* Effect.promise(() => filesystem.read(urlParams.path));
      }).pipe(
        Effect.catchTag("ArchiveDbError", (e) => Effect.die(e)),
        Effect.catchTag("ProvisioningError", (e) => Effect.die(e)),
      ),
    ),
);
