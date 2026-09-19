import { machines, snapshots } from "@cloudable/schema";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { type Context, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus, type EventBusError } from "../../services/EventBus";
import {
  type CapturedDisk,
  ProvisioningServiceTag,
  type SnapshotScope,
} from "../../services/ProvisioningService";
import { ArchiveDbError, InvalidLegalHoldReasonError } from "./errors";
import { SYSTEM_ACTOR, makeEnvelope } from "./events";
import { ensureInspectionFilesystem, releaseInspection } from "./inspection-registry";
import { resolveRetentionDays } from "./org-policy";
import { type MachineRow, dbTry, fetchMachine, fetchSnapshot } from "./queries";

export type SnapshotTrigger = "archive" | "upgrade" | "manual";
export type SnapshotRow = typeof snapshots.$inferSelect;

const DAY_MS = 1000 * 60 * 60 * 24;

/** `EventBus.publish` failures are our own infrastructure breaking, not a meaningful
 * outcome for callers of this domain — collapse into the same `ArchiveDbError` used for
 * DB failures rather than adding a distinct wire-visible error type. */
const publishOrDie = <A>(
  effect: Effect.Effect<A, EventBusError>,
): Effect.Effect<A, ArchiveDbError> =>
  effect.pipe(
    Effect.mapError(
      (cause) => new ArchiveDbError({ reason: `event_publish_failed: ${cause.reason}` }),
    ),
  );

/**
 * What the snapshot will actually store, from the machine's own last measurement of its
 * filesystems (`machines.volumeUsage`, written by the agent's report).
 *
 * This is the number a person means by "how big is the snapshot", and the number the
 * provider bills: a full snapshot is charged on used data, not on the size of the disk
 * it came from. `sizeBytes` alongside it is the provisioned size, which is identical on
 * every machine in the fleet and therefore tells you nothing about any of them.
 *
 * `undefined` when the machine never reported a measurement, or reported only the half
 * this scope does not cover. Never a zero standing in for "unknown" — a snapshot that
 * reports 0 bytes because nobody looked is the same class of lie as one that reports
 * 64 GiB because nobody looked.
 */
const measuredUsedBytes = (volumeUsage: unknown, scope: SnapshotScope): number | undefined => {
  if (typeof volumeUsage !== "object" || volumeUsage === null) return undefined;
  const read = (key: "persistent" | "root"): number | undefined => {
    const part = (volumeUsage as Record<string, unknown>)[key];
    if (typeof part !== "object" || part === null) return undefined;
    const used = (part as Record<string, unknown>).usedBytes;
    return typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : undefined;
  };
  const persistent = read("persistent");
  // "shallow" copies the persistent volume only, so that measurement IS the answer.
  if (scope === "shallow") return persistent;
  // "full" also copies the root filesystem. Both halves are needed, or the total would
  // silently understate by however much the OS disk holds.
  const root = read("root");
  return persistent !== undefined && root !== undefined ? persistent + root : undefined;
};

/**
 * Reads what the copied filesystem itself says it holds, straight out of its superblock.
 *
 * The fallback when no agent measurement exists — which was every snapshot of a machine
 * whose agent is old, gone, or never reported. Those rows had `usedBytes` null, so the
 * console fell back to the PROVISIONED size and showed "64.0 GiB max" for a disk holding
 * 1.56 GiB. A ceiling, in the place a person reads a size, forty times too big.
 *
 * Two 1 KiB reads and no directory walk, and it goes through the inspection registry so
 * the grant is shared and released on the normal grace period rather than churned.
 *
 * Best-effort by construction: any failure leaves `usedBytes` null, which is what the
 * column already means — "not measured", never "empty".
 */
const measureFromSnapshot = (
  snapshotId: string,
  provider: MachineRow["provider"],
  disks: ReadonlyArray<CapturedDisk>,
): Effect.Effect<number | undefined, never, ProvisioningServiceTag> => {
  // Only the persistent disk is readable (no partition-table parser for the OS disk), so
  // a `full` snapshot's total would understate by whatever the OS disk holds. Better to
  // report nothing than a confidently wrong number.
  const data = disks.find((disk) => disk.kind === "data");
  if (!data || disks.length !== 1) return Effect.succeed(undefined);

  return ensureInspectionFilesystem({
    sessionId: `measure:${snapshotId}`,
    provider,
    disk: data,
  }).pipe(
    Effect.map((filesystem) => filesystem.usage().usedBytes),
    // `catchAllCause`, not `catchAll`: this runs on the archive path, and a nice-to-have
    // size must never be able to fail an archive. A provider that throws rather than
    // returning an error is still just a snapshot whose size we do not know.
    Effect.catchAllCause(() => Effect.succeed(undefined)),
    Effect.tap(() => releaseInspection(`measure:${snapshotId}`)),
  );
};

/**
 * Captures a point-in-time snapshot of a machine's volume data. NOT its desired state or
 * configuration, despite `docs/spec.md` describing a snapshot as holding both — nothing
 * captures those, which is why `containsConfig` is written `false` and a `mode: "config"`
 * restore refuses. Region is inherited from the machine's own region.
 * `retentionDays` comes from org policy (`resolveSetting()`, default 30,
 * org-configurable — see `org-policy.ts`); `expiresAt` is computed from it. Emits
 * `snapshot.created`.
 *
 * `correlationId` defaults to a fresh ULID for a standalone call (`trigger: "manual"`
 * or `"upgrade"`) but should be passed through by a caller that is itself part of a
 * larger operation (`archiveMachine` passes its own correlation id, so `snapshot.created`
 * and `machine.archived` are linked as one operation).
 *
 * Signature is exact and load-bearing — units 16 (offboarding) and 18 (upgrade
 * transactionality) call this directly. Do not add required parameters.
 *
 * `knownMachine` is a purely-internal optimization: a caller that already fetched the
 * machine row (e.g. `archiveMachine`, right before calling this) can pass it to skip a
 * redundant `SELECT`. External callers should omit it — it is not part of the stable
 * contract the doc comment above refers to.
 *
 * `options` is the fifth parameter rather than two more positionals, so the exact
 * four-argument contract above keeps working untouched. It carries the two things only
 * the caller can know: which disks to capture, and whether the machine can be stopped
 * first (an archive can; an upgrade cannot — see `SnapshotDescriptor.quiesce`).
 *
 * THIS NOW ACTUALLY TAKES A SNAPSHOT. Until this change the function inserted a row and
 * nothing else — it never called `ProvisioningService`, this file did not even import
 * it, and every row was stamped with one hardcoded 32 GiB. Production ended up with six
 * "restorable" snapshots standing against two real Azure objects, and an upgrade that
 * deleted a machine's OS disk immediately after recording a backup of it that had never
 * been taken.
 */
/**
 * Destroys copies that were made but never recorded, after the write that would have
 * recorded them failed.
 *
 * Best-effort by construction: the caller is already failing, and the original error is
 * the one worth reporting. A delete that also fails is logged with the id, which is the
 * only thing that makes the leak findable afterwards — so the log line carries the
 * external id, not just a count.
 *
 * Never touches anything but the disks this one call captured.
 */
const rollbackCapturedDisks = (
  provisioning: Context.Tag.Service<ProvisioningServiceTag>,
  provider: "azure" | "docker" | "fake",
  disks: ReadonlyArray<CapturedDisk>,
  snapshotId: string,
): Effect.Effect<void> =>
  Effect.forEach(
    disks,
    (disk) =>
      provisioning
        .deleteSnapshotDisk({ provider, diskExternalId: disk.externalId })
        .pipe(
          Effect.catchAll((cause) =>
            Effect.logError(
              `snapshot ${snapshotId}: its row failed to write and ${disk.externalId} could not be cleaned up (${cause.reason}) — this disk is now orphaned at the provider`,
            ),
          ),
        ),
    { discard: true },
  );

export const createSnapshot = (
  machineId: string,
  trigger: SnapshotTrigger,
  correlationId: string = ulid(),
  knownMachine?: MachineRow,
  options?: { scope?: SnapshotScope; quiesce?: boolean },
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;

    const machine = knownMachine ?? (yield* fetchMachine(machineId));
    const retentionDays = yield* resolveRetentionDays(machine.orgId, machineId);
    const scope = options?.scope ?? "full";

    // Copy the disks BEFORE writing the row, so a row only ever exists for a copy that
    // was actually made. A provider failure propagates: `archiveMachine` already fails
    // on ProvisioningError, and `upgradeMachine` wraps this in Effect.either and aborts
    // the upgrade without touching the machine — which is the right answer, because a
    // pre-upgrade snapshot that did not happen must never be followed by a reimage.
    //
    // "not_found" is the one tolerated reason: a machine whose infrastructure is already
    // gone genuinely has nothing to copy, and that must not block archiving the record.
    // It is recorded as what it is — a snapshot naming no disks — rather than papered
    // over with a plausible-looking size.
    // Minted here, not left to the column default, so the provider can put it in the
    // resource name it creates. A provider name derived only from the disk is the same
    // name every time, and the second snapshot of a machine overwrites the first.
    const snapshotId = crypto.randomUUID();

    const captured = yield* provisioning
      .snapshot({
        machineId,
        provider: machine.provider,
        externalId: machine.externalResourceId,
        scope,
        snapshotId,
        quiesce: options?.quiesce ?? false,
      })
      .pipe(
        Effect.catchTag("ProvisioningError", (error) =>
          error.reason === "not_found"
            ? Effect.succeed({ disks: [] as ReadonlyArray<CapturedDisk>, sizeBytes: 0 })
            : Effect.fail(error),
        ),
      );

    // From here until a row is written, the copies exist at the provider and nothing in
    // the database names them. A failure inside that window used to leak them for good:
    // the provider call is deliberately first (a row must only ever exist for a copy that
    // was really made), so a DB error after it left an Azure snapshot no query could find
    // and no expiry sweep could ever delete. That is how orphans are made, and it was the
    // one remaining way to make a new one.
    //
    // `tapErrorCause`, not `tapError`, so an unexpected defect compensates too — a leak is
    // just as permanent either way. The original error still propagates untouched; callers
    // like `upgradeMachine` depend on seeing it.
    const snapshot = yield* Effect.gen(function* () {
      const measuredFromDisk =
        measuredUsedBytes(machine.volumeUsage, scope) === undefined
          ? yield* measureFromSnapshot(snapshotId, machine.provider, captured.disks)
          : undefined;

      const now = new Date();
      const expiresAt = new Date(now.getTime() + retentionDays * DAY_MS);

      const inserted = yield* dbTry(
        () =>
          db
            .insert(snapshots)
            .values({
              id: snapshotId,
              orgId: machine.orgId,
              machineId,
              trigger,
              region: machine.region,
              // The real total the provider reported, and the ids to aim a restore or an
              // expiry deletion at. Both were previously a hardcoded placeholder and
              // nothing at all, respectively.
              sizeBytes: captured.sizeBytes,
              // The agent's own measurement first: it saw the live machine and covers every
              // disk in scope. Reading the copy is the fallback, and covers the machines
              // whose agent never reported at all.
              usedBytes: measuredUsedBytes(machine.volumeUsage, scope) ?? measuredFromDisk ?? null,
              scope,
              capturedDisks: [...captured.disks],
              // False when the provider copied nothing, so the console stops labelling an
              // empty record as holding data.
              containsData: captured.disks.length > 0,
              // FALSE, because nothing captures configuration. This was hardcoded `true`
              // on the reasoning that "the machine's desired state lives in this database,
              // not on either disk" — but the database holds the state the machine has
              // NOW, not the state it had when the snapshot was taken, and a restore from
              // that is not a restore. Every snapshot in production has been claiming to
              // hold configuration that was never recorded anywhere.
              //
              // `docs/spec.md` does say a snapshot should hold "volume data plus machine
              // desired state and configuration". The gap is the capture, not this flag:
              // serialise the resolved settings and manifest into the row and this becomes
              // a real `true`, and `mode: "config"` becomes buildable with it.
              containsConfig: false,
              retentionDays,
              expiresAt,
              // A machine under legal hold (`machines.legalHold`) must produce a
              // snapshot that is ALSO under hold — otherwise the hold is silently
              // defeated the moment the machine is archived (invariant: "Retention
              // is honoured" fails when a snapshot outlives its retention window
              // without a legal hold — a snapshot that never inherited the hold in
              // the first place would incorrectly pass that check). The machine
              // itself carries no hold *reason*, only the boolean flag, so the
              // inherited reason is a fixed, honest statement of provenance rather
              // than fabricating detail the source of truth never had.
              legalHold: machine.legalHold,
              legalHoldReason: machine.legalHold
                ? "Inherited from machine legal hold at archive time"
                : null,
            })
            .returning(),
        "insert_snapshot",
      );
      const row = inserted[0];
      if (!row) {
        return yield* Effect.fail(
          new ArchiveDbError({ reason: "insert_snapshot_returned_no_row" }),
        );
      }
      return row;
    }).pipe(
      Effect.tapErrorCause(() =>
        rollbackCapturedDisks(provisioning, machine.provider, captured.disks, snapshotId),
      ),
    );

    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({ orgId: machine.orgId, machineId, correlationId, ...SYSTEM_ACTOR }),
          type: "snapshot.created",
          payload: {
            trigger,
            region: machine.region,
            sizeBytes: snapshot.sizeBytes ?? 0,
            scope,
          },
        },
      ]),
    );

    return snapshot;
  });

const requireNonEmptyReason = (reason: string, message: string) =>
  reason.trim().length === 0
    ? Effect.fail(new InvalidLegalHoldReasonError({ message }))
    : Effect.void;

/**
 * Places a legal hold on a snapshot, exempting it from the expiry sweep
 * (`computeExpirySweepCandidates`) regardless of `expiresAt`. Renders as a documented
 * exception, never an error. Emits `snapshot.legal_hold_set`.
 */
export const setLegalHold = (snapshotId: string, orgId: string, reason: string) =>
  Effect.gen(function* () {
    yield* requireNonEmptyReason(reason, "A legal hold requires a reason.");

    const db = yield* Db;
    const eventBus = yield* EventBus;
    const snapshot = yield* fetchSnapshot(snapshotId, orgId);

    yield* dbTry(
      () =>
        db
          .update(snapshots)
          .set({ legalHold: true, legalHoldReason: reason })
          .where(eq(snapshots.id, snapshotId)),
      "set_legal_hold",
    );

    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({
            orgId: snapshot.orgId,
            machineId: snapshot.machineId,
            correlationId: ulid(),
            ...SYSTEM_ACTOR,
          }),
          type: "snapshot.legal_hold_set",
          payload: { reason },
        },
      ]),
    );

    return { ...snapshot, legalHold: true, legalHoldReason: reason };
  });

/** Clears a previously-set legal hold. The retention clock resumes against the
 * snapshot's existing `expiresAt` (never recomputed). Emits `snapshot.legal_hold_cleared`. */
export const clearLegalHold = (snapshotId: string, orgId: string, reason: string) =>
  Effect.gen(function* () {
    yield* requireNonEmptyReason(reason, "Clearing a legal hold requires a reason.");

    const db = yield* Db;
    const eventBus = yield* EventBus;
    const snapshot = yield* fetchSnapshot(snapshotId, orgId);

    yield* dbTry(
      () =>
        db
          .update(snapshots)
          .set({ legalHold: false, legalHoldReason: null })
          .where(eq(snapshots.id, snapshotId)),
      "clear_legal_hold",
    );

    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({
            orgId: snapshot.orgId,
            machineId: snapshot.machineId,
            correlationId: ulid(),
            ...SYSTEM_ACTOR,
          }),
          type: "snapshot.legal_hold_cleared",
          payload: { reason },
        },
      ]),
    );

    return { ...snapshot, legalHold: false, legalHoldReason: null };
  });

/**
 * Snapshots eligible for the expiry sweep: past `expiresAt`, not already expired, and
 * not under legal hold. This query is the shared primitive both `expireOverdueSnapshots`
 * (the actual sweep, below) and the "retention is honoured" compliance check read from —
 * `orgId` is optional so the fleet-wide sweep can call it unscoped while the org-scoped
 * compliance check narrows it, without either maintaining its own copy of this filter.
 */
export const computeExpirySweepCandidates = (now: Date = new Date(), orgId?: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* dbTry(
      () =>
        db
          .select()
          .from(snapshots)
          .where(
            and(
              lt(snapshots.expiresAt, now),
              isNull(snapshots.expiredAt),
              eq(snapshots.legalHold, false),
              ...(orgId !== undefined ? [eq(snapshots.orgId, orgId)] : []),
            ),
          ),
      "compute_expiry_sweep_candidates",
    );
  });

/**
 * The actual expiry sweep: destroys every captured disk at the provider, then flips
 * `expiredAt` and publishes `snapshot.expired` for each overdue, non-legal-hold snapshot.
 *
 * DELETION COMES FIRST, and the row is only marked expired once it succeeded. For a long
 * time this set `expiredAt` and stopped there: the managed-disk snapshots stayed in the
 * subscription past their retention window while the console told people the volume data
 * had been hard-deleted, and compliance check #5 read `snapshot.expired` as proof that it
 * had. The check went green over a deletion that never happened, which is worse than a
 * check that fails. Ordering it this way means the event can only ever be written after
 * the thing it attests to actually occurred.
 *
 * A row whose disks could not all be destroyed is LEFT ALONE — not expired, no event —
 * and retried next pass. It keeps reading as overdue, so check #5 correctly stays red
 * while data that should be gone is still there. Deleting is idempotent
 * (`ProvisioningService.deleteSnapshotDisk`), so a retry after a partial pass re-runs the
 * disks that already succeeded without erroring on them.
 *
 * Rows that captured nothing (`capturedDisks: []`, written before snapshots became real —
 * six exist in production) are expired with `deletedDiskExternalIds: []`. There is no id
 * to aim a delete at, so nothing is destroyed and the event says so rather than implying
 * a deletion. Restore is genuinely unavailable for them either way: the control plane
 * cannot name the data to restore from it any more than it can to delete it.
 *
 * The record itself (id, machine, timestamps) is never touched beyond `expiredAt` —
 * "the record and full audit history persist permanently" per spec.
 */
export const expireOverdueSnapshots = (
  now: Date = new Date(),
): Effect.Effect<number, ArchiveDbError, Db | EventBus | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;

    const candidates = yield* computeExpirySweepCandidates(now);
    if (candidates.length === 0) return 0;

    // `computeExpirySweepCandidates` is shared with compliance check #5 and returns
    // snapshot columns only; the provider lives on the machine. Fetched in one query
    // here rather than by widening that shared primitive for this caller alone.
    const machineIds = [...new Set(candidates.map((snapshot) => snapshot.machineId))];
    const providerRows = yield* dbTry(
      () =>
        db
          .select({ id: machines.id, provider: machines.provider })
          .from(machines)
          .where(inArray(machines.id, machineIds)),
      "select_expiry_sweep_providers",
    );
    const providerFor = new Map(providerRows.map((row) => [row.id, row.provider]));

    let expired = 0;
    for (const snapshot of candidates) {
      const provider = providerFor.get(snapshot.machineId);
      if (!provider) {
        // The machine row is gone but its snapshot is not (invariant 6 archives machines
        // rather than deleting them, so this is a real anomaly). Without a provider there
        // is nothing to dispatch a delete to, and expiring the row would claim a deletion
        // that could not have been attempted.
        yield* Effect.logError(
          `expiry: snapshot ${snapshot.id} has no machine row (${snapshot.machineId}); cannot delete its disks`,
        );
        continue;
      }

      const deleted: string[] = [];
      let failed = false;
      for (const disk of snapshot.capturedDisks) {
        const outcome = yield* provisioning
          .deleteSnapshotDisk({ provider, diskExternalId: disk.externalId })
          .pipe(
            Effect.as(true),
            Effect.catchAll((cause) =>
              Effect.logError(
                `expiry: failed to delete disk ${disk.externalId} of snapshot ${snapshot.id}: ${cause.reason}`,
              ).pipe(Effect.as(false)),
            ),
          );
        if (outcome) deleted.push(disk.externalId);
        else failed = true;
      }

      // Partial success is not success. Leave the row overdue and try the whole thing
      // again next pass rather than recording an expiry over data still sitting there.
      if (failed) continue;

      yield* dbTry(
        () => db.update(snapshots).set({ expiredAt: now }).where(eq(snapshots.id, snapshot.id)),
        "expire_overdue_snapshot",
      );

      yield* publishOrDie(
        eventBus.publish([
          {
            ...makeEnvelope({
              orgId: snapshot.orgId,
              machineId: snapshot.machineId,
              correlationId: ulid(),
              ...SYSTEM_ACTOR,
            }),
            type: "snapshot.expired",
            payload: {
              createdAt: snapshot.createdAt.toISOString(),
              retentionDays: snapshot.retentionDays,
              deletedDiskExternalIds: deleted,
            },
          },
        ]),
      );
      expired++;
    }

    return expired;
  });

/**
 * Checks that every disk a snapshot recorded still exists at the provider, and flags the
 * rows where one does not.
 *
 * This exists because "restorable" was a claim nobody verified. A `snapshots` row names
 * its copies by `CapturedDisk.externalId`, nothing re-read those ids after writing them,
 * and production has rows pointing at objects since replaced or cleaned up — still
 * showing a green badge and a live Restore button over data that is gone. Pressing it
 * would have gone through approval, up to dual sign-off, to restore nothing.
 *
 * It is the third time this class of bug has been fixed. The first two taught
 * `getSnapshotSubState` more about the ROW (it captured nothing; it has expired). This
 * one cannot be learned from the row at all — only the provider knows the object is
 * gone — which is why it needs a sweep rather than a better pure function.
 *
 * FLAGS, NEVER CORRECTS (invariant 5). `dataMissingAt` is a first-observation stamp and
 * the row is never otherwise touched: `capturedDisks` keeps the ids that went missing,
 * because "which object did we lose" is the question anyone investigating will ask.
 *
 * Deliberately scoped to rows that are NOT expired. Past its retention window the data
 * being gone is the expected outcome, and re-reporting it as a fault would bury the
 * anomalies in noise.
 */
export const detectMissingSnapshotData = (
  now: Date = new Date(),
): Effect.Effect<number, ArchiveDbError, Db | EventBus | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;

    const candidates = yield* dbTry(
      () =>
        db
          .select({
            id: snapshots.id,
            orgId: snapshots.orgId,
            machineId: snapshots.machineId,
            capturedDisks: snapshots.capturedDisks,
            expiresAt: snapshots.expiresAt,
            provider: machines.provider,
          })
          .from(snapshots)
          .innerJoin(machines, eq(snapshots.machineId, machines.id))
          .where(and(isNull(snapshots.expiredAt), isNull(snapshots.dataMissingAt))),
      "select_snapshot_integrity_candidates",
    );

    let flagged = 0;
    for (const row of candidates) {
      const disks = row.capturedDisks;
      // A row that captured nothing is already `empty`; there is no id to check and
      // nothing a provider call could tell us.
      if (disks.length === 0) continue;

      const missing: string[] = [];
      for (const disk of disks) {
        const exists = yield* provisioning
          .snapshotDiskExists({ provider: row.provider, diskExternalId: disk.externalId })
          .pipe(
            // A provider that cannot answer is not the same as an object that is gone.
            // Treat an error as "present" and try again next pass: flagging on a
            // transient failure would put a permanent, wrong mark on a healthy snapshot,
            // and `dataMissingAt` is never cleared.
            Effect.catchAll(() => Effect.succeed(true)),
          );
        if (!exists) missing.push(disk.externalId);
      }
      if (missing.length === 0) continue;

      yield* dbTry(
        () => db.update(snapshots).set({ dataMissingAt: now }).where(eq(snapshots.id, row.id)),
        "flag_snapshot_data_missing",
      );

      yield* publishOrDie(
        eventBus.publish([
          {
            ...makeEnvelope({
              orgId: row.orgId,
              machineId: row.machineId,
              correlationId: row.id,
              ...SYSTEM_ACTOR,
            }),
            type: "snapshot.data_missing",
            payload: {
              missingDiskExternalIds: missing,
              recordedDiskCount: disks.length,
              expiresAt: row.expiresAt.toISOString(),
            },
          },
        ]),
      );
      flagged++;
    }

    return flagged;
  });
