import { Data } from "effect";

/**
 * Errors `upgradeMachine` / `isEligibleForUpgrade` can fail with. These are
 * precondition/infra failures only — a failed apply or a failed
 * verification is NOT one of these, it is a normal (if unwanted) outcome
 * represented in the `UpgradeResult` value (see below), because callers
 * need to inspect it without unwrapping an error channel.
 */
export class UpgradeError extends Data.TaggedError("UpgradeError")<{
  reason: "machine_not_found" | "not_eligible" | "db_error";
  cause?: unknown;
  /** Populated only for "not_eligible" — when the machine becomes eligible again. */
  nextEligibleAt?: Date;
}> {}

/**
 * - "success" — snapshot, apply, and verify all succeeded. `machines.image`
 *   was updated and `machine.reimaged` was emitted.
 * - "rolled_back" — apply and/or verify failed; the pre-upgrade snapshot was
 *   restored. `machines.image` is unchanged. **Currently unreachable**: no
 *   `ProvisioningService` has a restore operation, so `domain/upgrade/snapshot-port.ts`
 *   fails rather than fabricating a restore, and every failed apply lands on
 *   "rollback_failed" instead. Kept in the union because it becomes reachable the
 *   moment a real restore exists, and it is already a wire value
 *   (`http/routes/upgrade.ts`) that consumers handle.
 * - "aborted" — the pre-upgrade snapshot itself could not be taken. Apply
 *   and verify were never attempted, so nothing on the machine changed and
 *   there is nothing to roll back.
 * - "rollback_failed" — apply and/or verify failed and the machine was NOT put back.
 *   The machine's real state is now unknown relative to `machines.image` (which is
 *   left unchanged, and on this path is therefore NOT where the machine actually is —
 *   the reimage already happened and the old OS disk is gone). Needs manual
 *   attention; this is what the drift link is for. Until a real restore exists this
 *   is the outcome of every failed apply, not a rare worst case.
 */
export type UpgradeOutcome = "success" | "rolled_back" | "aborted" | "rollback_failed";

export interface UpgradeResult {
  outcome: UpgradeOutcome;
  machineId: string;
  attemptId: string;
  previousImage: string;
  /** The machine's image after this attempt: `targetImage` on success, `previousImage` otherwise (rollback restores it or nothing was ever changed). */
  currentImage: string;
  targetImage: string;
  /** The pre-upgrade snapshot taken for this attempt, or `null` for "aborted" (never taken). */
  snapshotId: string | null;
  /** Set only when outcome is "rolled_back" — the snapshot actually restored. Never set
   * today: see the "rolled_back" note above. */
  restoredSnapshotId?: string;
  /** When this machine becomes eligible for another upgrade attempt — see `apps/control-plane/src/domain/upgrade/backoff.ts`. */
  nextEligibleAt: Date;
  /**
   * Deep-link to the drift view, set only on a non-"success" outcome.
   * Console units should honor this exact shape (`/machines/:id#drift`) when
   * the drift view lands — see `docs/frontend.md` routing conventions.
   */
  driftUrl?: string;
  failureReason?: string;
}

/** URL shape every non-success `UpgradeResult` deep-links to. Kept as one function so the shape only needs to change in one place. */
export const driftViewUrl = (machineId: string): string => `/machines/${machineId}#drift`;
