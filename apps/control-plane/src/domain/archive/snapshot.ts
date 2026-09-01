import { snapshots } from "@cloudable/schema";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus, type EventBusError } from "../../services/EventBus";
import { ArchiveDbError, InvalidLegalHoldReasonError } from "./errors";
import { SYSTEM_ACTOR, makeEnvelope } from "./events";
import { resolveRetentionDays } from "./org-policy";
import { PLACEHOLDER_SNAPSHOT_SIZE_BYTES } from "./pricing";
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
 * Captures a point-in-time snapshot of a machine: volume data AND its desired
 * state/configuration (`containsData`/`containsConfig` both default `true` — spec §14
 * "Snapshot contents"). Region is inherited from the machine's own region.
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
 */
export const createSnapshot = (
  machineId: string,
  trigger: SnapshotTrigger,
  correlationId: string = ulid(),
  knownMachine?: MachineRow,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    const machine = knownMachine ?? (yield* fetchMachine(machineId));
    const retentionDays = yield* resolveRetentionDays(machine.orgId, machineId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + retentionDays * DAY_MS);

    const inserted = yield* dbTry(
      () =>
        db
          .insert(snapshots)
          .values({
            orgId: machine.orgId,
            machineId,
            trigger,
            region: machine.region,
            // No real Azure disk-usage reporting exists in this build — see pricing.ts.
            sizeBytes: PLACEHOLDER_SNAPSHOT_SIZE_BYTES,
            containsData: true,
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
          payload: { trigger, region: machine.region, sizeBytes: snapshot.sizeBytes ?? 0 },
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
 * exception, never an error (spec §14). Emits `snapshot.legal_hold_set`.
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
 * The actual expiry sweep (spec §14 "Archived, expired — clock elapsed, volume data
 * hard-deleted"): flips `expiredAt` on every overdue, non-legal-hold snapshot and
 * publishes `snapshot.expired` for each. Before this, `computeExpirySweepCandidates`
 * was a real, tested query with no caller anywhere — nothing ever actually set
 * `expiredAt`, so "Archived, expired" never happened and every snapshot past its
 * retention window just sat there indefinitely as "restorable".
 *
 * This build has no real disk to hard-delete (no live Azure account — see
 * `services/ProvisioningService.azure.ts`); `getSnapshotSubState`/`restoreUnavailableReason`
 * (sub-state.ts) already derive restore-availability purely from `expiredAt`, so setting
 * it is the whole state transition this domain needs to make restore correctly
 * unavailable. The record itself (id, machine, timestamps) is never touched beyond that —
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
