import { snapshots } from "@cloudable/schema";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { Effect } from "effect";
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
 * Captures a point-in-time snapshot of a machine: volume data AND its desired
 * state/configuration (`containsData`/`containsConfig` both default `true`).
 * Region is inherited from the machine's own region.
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
            usedBytes: measuredUsedBytes(machine.volumeUsage, scope) ?? null,
            scope,
            capturedDisks: [...captured.disks],
            // False when the provider copied nothing, so the console stops labelling an
            // empty record "data+config". `containsConfig` stays true regardless: the
            // machine's desired state lives in this database, not on either disk.
            containsData: captured.disks.length > 0,
            containsConfig: true,
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
    const snapshot = inserted[0];
    if (!snapshot) {
      return yield* Effect.fail(new ArchiveDbError({ reason: "insert_snapshot_returned_no_row" }));
    }

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
 * The actual expiry sweep: flips `expiredAt` on every overdue, non-legal-hold snapshot and
 * publishes `snapshot.expired` for each. Before this, `computeExpirySweepCandidates`
 * was a real, tested query with no caller anywhere — nothing ever actually set
 * `expiredAt`, so "Archived, expired" never happened and every snapshot past its
 * retention window just sat there indefinitely as "restorable".
 *
 * KNOWN GAP, and a real one: this sets `expiredAt` and publishes `snapshot.expired`. It
 * does NOT delete anything at the provider. `getSnapshotSubState` /
 * `restoreUnavailableReason` (sub-state.ts) derive restore-availability purely from
 * `expiredAt`, so setting it is enough to make restore correctly unavailable — but the
 * managed-disk snapshots stay in the subscription, past their retention window, while
 * the console and the evidence export both read as expired.
 *
 * Compliance check #5 ("retention is honoured") treats `snapshot.expired` as proof that
 * "hard-deletion happened on schedule". It is not. The check goes green over a deletion
 * that never happened, which is worse than a check that fails.
 *
 * The comment here used to say "this build has no real disk to hard-delete (no live
 * Azure account)". That was false: the azure adapter has been provisioning production
 * machines for some time. What was actually missing was a provider-side delete and a
 * recorded id to aim it at. `snapshots.capturedDisks` now carries those ids for every
 * snapshot taken from this point on, so closing this needs a `ProvisioningService`
 * delete operation and a call to it from here.
 *
 * The record itself (id, machine, timestamps) is never touched beyond `expiredAt` —
 * "the record and full audit history persist permanently" per spec.
 */
export const expireOverdueSnapshots = (
  now: Date = new Date(),
): Effect.Effect<number, ArchiveDbError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    const candidates = yield* computeExpirySweepCandidates(now);
    if (candidates.length === 0) return 0;

    const ids = candidates.map((snapshot) => snapshot.id);
    yield* dbTry(
      () => db.update(snapshots).set({ expiredAt: now }).where(inArray(snapshots.id, ids)),
      "expire_overdue_snapshots",
    );

    yield* publishOrDie(
      eventBus.publish(
        candidates.map((snapshot) => ({
          ...makeEnvelope({
            orgId: snapshot.orgId,
            machineId: snapshot.machineId,
            correlationId: ulid(),
            ...SYSTEM_ACTOR,
          }),
          type: "snapshot.expired" as const,
          payload: {
            createdAt: snapshot.createdAt.toISOString(),
            retentionDays: snapshot.retentionDays,
          },
        })),
      ),
    );

    return candidates.length;
  });
