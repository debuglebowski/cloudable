import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulid";
import { machines, upgradeAttempts } from "@cloudable/schema";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { computeNextEligibleAt } from "./backoff";
import { createSnapshot, restoreSnapshot } from "./snapshot-port";
import { driftViewUrl, UpgradeError, type UpgradeOutcome, type UpgradeResult } from "./types";

/**
 * Transactional OS upgrade (spec §19 "Upgrades are transactional"; spec §7:
 * "An OS upgrade is: reimage, remount persistent volume, reinstall declared
 * packages. One button."):
 *
 *   1. snapshot   — `createSnapshot(machineId, "upgrade")` (unit 15 stub, see `./snapshot-port.ts`)
 *   2. apply      — `ProvisioningService.reimage(...)`
 *   3. verify     — `ProvisioningService.reconcile(...)`; anything other than
 *                    `state: "running"` is treated as a verification failure.
 *                    The port (bootstrap-defined) only ever reports a status,
 *                    not a rich drift payload, so "state !== running" is the
 *                    acceptable-mismatch threshold this unit implements
 *                    against — documented here since it's a deliberate
 *                    reading of a constrained interface, not the only
 *                    possible one.
 *   4. on success — update `machines.image`, emit `machine.reimaged`.
 *      on failure — restore the pre-upgrade snapshot; `machines.image` is
 *                    left untouched either way.
 *
 * Every attempt — success or any failure — records a row in
 * `upgrade_attempts` and pushes `nextEligibleAt` forward by a full backoff
 * interval (see `./backoff.ts`), so a persistently failing machine backs off
 * instead of being retried every cycle. `isEligibleForUpgrade` is how a
 * future caller (e.g. a scheduler) checks that clock before calling
 * `upgradeMachine` again; `upgradeMachine` itself also enforces it.
 */

const UPGRADE_ACTOR_ID = "control-plane:upgrade";

interface LatestAttempt {
  consecutiveFailures: number;
  nextEligibleAt: Date;
}

const fetchLatestAttempt = (machineId: string): Effect.Effect<LatestAttempt | undefined, UpgradeError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            consecutiveFailures: upgradeAttempts.consecutiveFailures,
            nextEligibleAt: upgradeAttempts.nextEligibleAt,
          })
          .from(upgradeAttempts)
          .where(eq(upgradeAttempts.machineId, machineId))
          .orderBy(desc(upgradeAttempts.attemptedAt))
          .limit(1),
      catch: (cause) => new UpgradeError({ reason: "db_error", cause }),
    });
    return rows[0];
  });

/** Whether `machineId` may be upgraded right now, per the backoff clock left by its most recent attempt (if any). */
export const isEligibleForUpgrade = (machineId: string): Effect.Effect<boolean, UpgradeError, Db> =>
  Effect.gen(function* () {
    const latest = yield* fetchLatestAttempt(machineId);
    if (!latest) return true;
    return Date.now() >= latest.nextEligibleAt.getTime();
  });

/**
 * `machines.image` and the `upgrade_attempts` row that records the success
 * must land atomically — otherwise a crash between the two would leave the
 * image changed with no ledger entry, and `isEligibleForUpgrade` would
 * (wrongly) report the machine as never having been attempted. The
 * `machine.reimaged` event is deliberately published AFTER this commits,
 * not inside it: `EventBus` resolves its own `Db` handle rather than
 * accepting a transaction, so it can't participate in the same transaction
 * without changing that shared service's interface. Ordering it after means
 * the (already rare) failure mode is "a real change is audited a moment
 * late", not "an event claims a change that never happened."
 */
const applySuccessAtomically = (params: {
  orgId: string;
  machineId: string;
  previousImage: string;
  targetImage: string;
  previousConsecutiveFailures: number;
  now: Date;
  preUpgradeSnapshotId: string;
}): Effect.Effect<{ id: string; nextEligibleAt: Date }, UpgradeError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const { consecutiveFailures, nextEligibleAt, intervalMs } = computeNextEligibleAt(params.now, {
      outcome: "success",
      previousConsecutiveFailures: params.previousConsecutiveFailures,
    });

    const row = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx
            .update(machines)
            .set({ image: params.targetImage, lastVerifiedAt: params.now })
            .where(eq(machines.id, params.machineId));

          const [inserted] = await tx
            .insert(upgradeAttempts)
            .values({
              orgId: params.orgId,
              machineId: params.machineId,
              previousImage: params.previousImage,
              targetImage: params.targetImage,
              outcome: "success",
              preUpgradeSnapshotId: params.preUpgradeSnapshotId,
              consecutiveFailures,
              backoffMs: intervalMs,
              attemptedAt: params.now,
              nextEligibleAt,
            })
            .returning({ id: upgradeAttempts.id });

          if (!inserted) {
            throw new Error("insert returned no row");
          }
          return inserted;
        }),
      catch: (cause) => new UpgradeError({ reason: "db_error", cause }),
    });

    return { id: row.id, nextEligibleAt };
  });

interface RecordAttemptParams {
  orgId: string;
  machineId: string;
  previousImage: string;
  targetImage: string;
  outcome: UpgradeOutcome;
  previousConsecutiveFailures: number;
  now: Date;
  preUpgradeSnapshotId?: string | null;
  restoredSnapshotId?: string | null;
  detail?: string | null;
}

const recordAttempt = (
  params: RecordAttemptParams,
): Effect.Effect<{ id: string; nextEligibleAt: Date }, UpgradeError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const { consecutiveFailures, nextEligibleAt, intervalMs } = computeNextEligibleAt(params.now, {
      outcome: params.outcome === "success" ? "success" : "failure",
      previousConsecutiveFailures: params.previousConsecutiveFailures,
    });

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(upgradeAttempts)
          .values({
            orgId: params.orgId,
            machineId: params.machineId,
            previousImage: params.previousImage,
            targetImage: params.targetImage,
            outcome: params.outcome,
            preUpgradeSnapshotId: params.preUpgradeSnapshotId ?? null,
            restoredSnapshotId: params.restoredSnapshotId ?? null,
            consecutiveFailures,
            backoffMs: intervalMs,
            detail: params.detail ?? null,
            attemptedAt: params.now,
            nextEligibleAt,
          })
          .returning({ id: upgradeAttempts.id }),
      catch: (cause) => new UpgradeError({ reason: "db_error", cause }),
    });

    const row = rows[0];
    if (!row) {
      return yield* Effect.fail(new UpgradeError({ reason: "db_error", cause: "insert returned no row" }));
    }
    return { id: row.id, nextEligibleAt };
  });

export const upgradeMachine = (
  machineId: string,
  targetImage: string,
): Effect.Effect<UpgradeResult, UpgradeError, Db | EventBus | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;

    const machineRows = yield* Effect.tryPromise({
      try: () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
      catch: (cause) => new UpgradeError({ reason: "db_error", cause }),
    });
    const machine = machineRows[0];
    if (!machine) {
      return yield* Effect.fail(new UpgradeError({ reason: "machine_not_found", cause: machineId }));
    }

    // KNOWN LIMITATION: this is a read of the latest attempt, not a lock —
    // two concurrent `upgradeMachine` calls for the SAME machine (a retried
    // request racing the original, or a future scheduler firing alongside a
    // manual trigger) can both read "eligible" before either has inserted
    // its own attempt row, and both proceed. Closing this fully needs either
    // a per-machine advisory lock (tricky to get right against a pooled
    // connection — the lock and its release must land on the same physical
    // connection) or a per-machine job queue upstream of this function.
    // Out of scope for this unit; flagged for whichever unit builds the
    // scheduler that becomes the primary caller.
    const latestAttempt = yield* fetchLatestAttempt(machineId);
    const now = new Date();
    if (latestAttempt && now.getTime() < latestAttempt.nextEligibleAt.getTime()) {
      return yield* Effect.fail(
        new UpgradeError({ reason: "not_eligible", nextEligibleAt: latestAttempt.nextEligibleAt }),
      );
    }
    const previousConsecutiveFailures = latestAttempt?.consecutiveFailures ?? 0;

    const previousImage = machine.image;
    const orgId = machine.orgId;
    const correlationId = ulid();

    // --- 1. snapshot -----------------------------------------------------
    const snapshotOutcome = yield* Effect.either(createSnapshot(machineId, "upgrade"));
    if (snapshotOutcome._tag === "Left") {
      const attempt = yield* recordAttempt({
        orgId,
        machineId,
        previousImage,
        targetImage,
        outcome: "aborted",
        previousConsecutiveFailures,
        now,
        preUpgradeSnapshotId: null,
        detail: `pre-upgrade snapshot failed: ${snapshotOutcome.left.reason}`,
      });
      return {
        outcome: "aborted",
        machineId,
        attemptId: attempt.id,
        previousImage,
        currentImage: previousImage,
        targetImage,
        snapshotId: null,
        nextEligibleAt: attempt.nextEligibleAt,
        driftUrl: driftViewUrl(machineId),
        failureReason: `pre-upgrade snapshot failed: ${snapshotOutcome.left.reason}`,
      } satisfies UpgradeResult;
    }
    const snapshot = snapshotOutcome.right;

    // --- 2. apply (reimage) -----------------------------------------------
    const reimageOutcome = yield* Effect.either(
      provisioning.reimage({ machineId, orgId, region: machine.region, sizeSku: machine.sizeSku, targetImage }),
    );

    // --- 3. verify declared state ------------------------------------------
    let failureReason: string | undefined;
    if (reimageOutcome._tag === "Left") {
      failureReason = `reimage failed: ${reimageOutcome.left.reason}`;
    } else {
      const reconcileOutcome = yield* Effect.either(provisioning.reconcile(machineId));
      if (reconcileOutcome._tag === "Left") {
        failureReason = `verification call failed: ${reconcileOutcome.left.reason}`;
      } else if (reconcileOutcome.right.state !== "running") {
        failureReason = `verification failed: reconcile reported state "${reconcileOutcome.right.state}" (expected "running")`;
      }
    }

    if (!failureReason) {
      // --- success ---------------------------------------------------------
      // `machines.image` and the attempt ledger row commit atomically — see
      // `applySuccessAtomically`'s doc comment.
      const attempt = yield* applySuccessAtomically({
        orgId,
        machineId,
        previousImage,
        targetImage,
        previousConsecutiveFailures,
        now,
        preUpgradeSnapshotId: snapshot.snapshotId,
      });

      yield* eventBus
        .publish([
          {
            type: "machine.reimaged",
            payload: { previousImage, currentImage: targetImage },
            occurredAt: now,
            orgId,
            actorType: "system",
            actorId: UPGRADE_ACTOR_ID,
            machineId,
            correlationId,
            schemaVersion: 1,
            // `EventBus.publish` assigns fresh values for both of these on
            // every event it's given, overwriting whatever's here — but
            // `DomainEvent` (correctly) requires them present at the type
            // level, so these are just placeholders.
            id: "",
            recordedAt: now,
          },
        ])
        .pipe(Effect.mapError((cause) => new UpgradeError({ reason: "db_error", cause })));

      return {
        outcome: "success",
        machineId,
        attemptId: attempt.id,
        previousImage,
        currentImage: targetImage,
        targetImage,
        snapshotId: snapshot.snapshotId,
        nextEligibleAt: attempt.nextEligibleAt,
      } satisfies UpgradeResult;
    }

    // --- 4. roll back --------------------------------------------------------
    const restoreOutcome = yield* Effect.either(
      restoreSnapshot(snapshot.snapshotId, "full", {
        targetMachineId: machineId,
        approvalId: null,
        reason: `automatic rollback of failed upgrade to ${targetImage}: ${failureReason}`,
      }),
    );

    const outcome: UpgradeOutcome = restoreOutcome._tag === "Right" ? "rolled_back" : "rollback_failed";
    const restoredSnapshotId = restoreOutcome._tag === "Right" ? snapshot.snapshotId : null;
    const detail =
      restoreOutcome._tag === "Right" ? failureReason : `${failureReason}; rollback also failed: ${restoreOutcome.left.reason}`;

    const attempt = yield* recordAttempt({
      orgId,
      machineId,
      previousImage,
      targetImage,
      outcome,
      previousConsecutiveFailures,
      now,
      preUpgradeSnapshotId: snapshot.snapshotId,
      restoredSnapshotId,
      detail,
    });

    return {
      outcome,
      machineId,
      attemptId: attempt.id,
      previousImage,
      currentImage: previousImage,
      targetImage,
      snapshotId: snapshot.snapshotId,
      nextEligibleAt: attempt.nextEligibleAt,
      driftUrl: driftViewUrl(machineId),
      failureReason: detail,
      // `exactOptionalPropertyTypes` treats an explicit `undefined` as
      // different from an absent key — spread it in only when it has a
      // value, rather than assigning `restoredSnapshotId ?? undefined`.
      ...(restoredSnapshotId ? { restoredSnapshotId } : {}),
    } satisfies UpgradeResult;
  });
