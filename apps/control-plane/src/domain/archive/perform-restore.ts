import { type CapturedDisk, machines } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { MachineService } from "../machine/MachineService";
import type { MachineRow } from "./queries";
import { dbTry } from "./queries";
import type { SnapshotRow } from "./snapshot";

/**
 * The provider half of a restore — the part that was missing entirely.
 *
 * Shared by both entry points in `restore.ts`: the immediately-approved path and
 * `resumeRestore`. Neither may publish `snapshot.restored` until this has succeeded,
 * because that event is the permanent claim that a machine got its data back, and for a
 * long time it was written over nothing at all.
 */

/** The snapshot's captured DATA disk. The OS disk is never read here — a restore always
 * rebuilds the OS from the catalog image, so an `os` entry is irrelevant to it. */
export function dataDiskOf(snapshot: { capturedDisks: CapturedDisk[] }): CapturedDisk | undefined {
  return snapshot.capturedDisks.find((disk) => disk.kind === "data");
}

/**
 * States a machine may be overwritten from.
 *
 * `archived_expired` is excluded on purpose: it is the one state the product tells people
 * is unrecoverable, and nothing in this codebase ever writes it — a row that reads expired
 * got there by hand and deserves a human, not an automatic revival. `provisioning` is
 * excluded because something else is already building it.
 */
export const RESTORABLE_ONTO_STATES = [
  "running",
  "stopped",
  "error",
  "archived_restorable",
] as const;

/**
 * Claims the machine for this restore, in one conditional statement.
 *
 * There is no lock anywhere in this codebase (`UpgradeService` documents the identical gap
 * for upgrades), so the row's own state is the claim: moving it to `provisioning` both
 * records that a restore is under way and blocks a second one, which will find a state
 * outside `RESTORABLE_ONTO_STATES` and get nothing back.
 *
 * Clearing `archivedAt` in the same statement matters. Restore is the arrow back from
 * `archived_restorable` — `docs/spec.md`'s whole point for that sub-state — and nothing
 * else in the system will ever move the row: `markVerified` refuses to revive an archived
 * row, status-refresh takes its `already_archived` no-op branch, the compliance checks
 * exclude it, and offboarding skips it. A rebuilt machine left reading archived would run,
 * bill, and serve sessions while governed by nothing.
 *
 * Returns the previous state (so the caller knows whether it un-archived something) or
 * `null` when the row was not claimable.
 */
export const claimMachineForRestore = (
  machineId: string,
): Effect.Effect<string | null, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const before = yield* dbTry(
      () => db.select({ state: machines.state }).from(machines).where(eq(machines.id, machineId)),
      "read_machine_state_for_restore",
    ).pipe(Effect.catchAll(() => Effect.succeed([])));
    const previous = before[0]?.state;
    if (!previous) return null;

    const claimed = yield* dbTry(
      () =>
        db
          .update(machines)
          .set({ state: "provisioning", lastError: null, archivedAt: null })
          .where(
            and(
              eq(machines.id, machineId),
              // Re-checked in the statement, not just read above: between the read and
              // this write another restore, an archive or a create may have moved it.
              inArray(machines.state, [...RESTORABLE_ONTO_STATES]),
            ),
          )
          .returning({ id: machines.id }),
      "claim_machine_for_restore",
    ).pipe(Effect.catchAll(() => Effect.succeed([])));

    return claimed.length > 0 ? previous : null;
  });

/**
 * Records the outcome of the provider work on the machine row.
 *
 * On failure the row says `error` and `externalResourceId` is cleared, because the old VM
 * really is gone — a stale id makes `resolveVmNames` 404 and then search tags for
 * something that no longer exists. `null` is also the safe value: `toLastKnownStatus` maps
 * `error` to `"error"`, never `"missing"`, so status-refresh calls `reconcile` (which
 * fails loudly) rather than `create` (which would quietly build a machine nobody asked
 * for).
 *
 * On success it stays `provisioning`. ARM returns when the deployment exists, not when
 * cloud-init has mounted /home and the agent has attested — the agent's own check-in
 * promotes it, which is the same reasoning `MachineService.create` spells out.
 */
export const recordRestoreOutcome = (
  machineId: string,
  outcome: { state: "provisioning"; externalId: string | null } | { state: "error"; error: string },
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* dbTry(
      () =>
        db
          .update(machines)
          .set(
            outcome.state === "error"
              ? { state: "error", lastError: outcome.error, externalResourceId: null }
              : { state: "provisioning", lastError: null, externalResourceId: outcome.externalId },
          )
          .where(eq(machines.id, machineId)),
      "record_restore_outcome",
    ).pipe(Effect.catchAll(() => Effect.void));
  });

/**
 * Puts the snapshot's data disk onto an existing machine.
 *
 * Returns `null` on provider failure, having already recorded the machine as `error` —
 * the caller must not publish `snapshot.restored` or mark the restore request completed,
 * so that a retry is still possible. Nothing is rolled back deliberately: a failure here
 * leaves the restored disk intact under the canonical name with no VM attached, and an
 * automatic rollback would mean a second destructive sequence while the first is already
 * failing, against the only remaining copy.
 */
export const performRestoreOntoMachine = (
  snapshot: SnapshotRow,
  machine: MachineRow,
  dataDisk: CapturedDisk,
): Effect.Effect<string | null, never, Db | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const provisioning = yield* ProvisioningServiceTag;

    const status = yield* provisioning
      .restoreDataDisk({
        machineId: machine.id,
        orgId: machine.orgId,
        provider: machine.provider,
        region: machine.region,
        sizeSku: machine.sizeSku,
        image: machine.image,
        name: machine.name,
        // No packages, deliberately. `CLOUDABLE_PACKAGES` is set on the agent's systemd
        // unit and read by nothing, and the manifest is a permission list that nothing
        // converges a machine towards (invariant 4) — so a restored machine installs
        // nothing on boot, same as a reimaged one. A person asks per package.
        externalId: machine.externalResourceId,
        dataDiskSnapshotId: dataDisk.externalId,
      })
      .pipe(
        Effect.map((s) => ({ ok: true as const, s })),
        Effect.catchAll((cause) => Effect.succeed({ ok: false as const, cause })),
      );

    if (!status.ok) {
      const message = `restore of snapshot ${snapshot.id} failed at the provider: ${status.cause.message}`;
      yield* Effect.logError(`machine ${machine.id}: ${message}`);
      yield* recordRestoreOutcome(machine.id, { state: "error", error: message });
      return null;
    }

    yield* recordRestoreOutcome(machine.id, {
      state: "provisioning",
      externalId: status.s.externalId,
    });
    return machine.id;
  });

/**
 * Provisions a NEW machine whose `/home` comes from the snapshot.
 *
 * Reuses `MachineService.create` wholesale rather than reimplementing it — catalog
 * validation, name generation, `machine.created` / `machine.owner_assigned`, and the
 * error handling that records a provisioning failure without losing the row. The only
 * difference from an ordinary create is `dataDiskSourceSnapshotId`.
 *
 * Shape comes from the snapshot's ORIGINAL machine, which still exists (invariant 6
 * archives, never deletes) — the person restoring is asking for that machine back, not
 * for a chance to re-pick its size.
 */
export const performRestoreIntoNewMachine = (
  source: MachineRow,
  dataDisk: CapturedDisk,
  owner: { ownerPersonId: string; name?: string; actorPersonId: string },
): Effect.Effect<string | null, never, Db | MachineService> =>
  Effect.gen(function* () {
    const machineService = yield* MachineService;
    const created = yield* machineService
      .create({
        orgId: source.orgId,
        provider: source.provider,
        region: source.region,
        sizeSku: source.sizeSku,
        image: source.image,
        ownerPersonId: owner.ownerPersonId,
        actorPersonId: owner.actorPersonId,
        ...(owner.name === undefined ? {} : { name: owner.name }),
        dataDiskSourceSnapshotId: dataDisk.externalId,
      })
      .pipe(
        Effect.map((row) => row.id),
        Effect.catchAll(() => Effect.succeed(null)),
      );

    if (created === null) return null;

    // `create` never fails on a provisioning error — it records `state: "error"` and
    // returns the row. So a non-null id here does not yet mean the machine came up, and
    // the caller must check before claiming the restore happened.
    const db = yield* Db;
    const rows = yield* dbTry(
      () => db.select({ state: machines.state }).from(machines).where(eq(machines.id, created)),
      "read_new_machine_state",
    ).pipe(Effect.catchAll(() => Effect.succeed([])));

    if (rows[0]?.state === "error") {
      yield* Effect.logError(
        `restore into new machine ${created} failed: the machine was created but provisioning reported an error`,
      );
      return null;
    }
    return created;
  });
