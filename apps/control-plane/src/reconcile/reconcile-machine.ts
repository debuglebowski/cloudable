import { Data, Effect } from "effect";
import {
  type MachineStatus,
  type ProvisioningError,
  ProvisioningServiceTag,
} from "../services/ProvisioningService";
import type { DesiredMachineState, ReconcileMachineResult } from "./types";

export class ReconcileError extends Data.TaggedError("ReconcileError")<{
  reason: "archived_requires_restore";
  machineId: string;
}> {}

/**
 * Packages reported as running that aren't in the declared manifest.
 *
 * Deliberately one-directional: entries declared but not reported (i.e.
 * "missing") are never surfaced here, because surfacing them alongside
 * "undeclared" would invite a caller to treat this as a to-install list.
 * Reconcile only closes gaps by removing/flagging the undeclared — it never
 * installs.
 */
export const diffUndeclaredPackages = (
  declared: ReadonlyArray<string>,
  reported: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const declaredSet = new Set(declared);
  return reported.filter((pkg) => !declaredSet.has(pkg));
};

/**
 * Reconciles one machine's desired state against its last-known provisioning
 * status, calling exactly one of `ProvisioningService.create` / `.archive` /
 * `.reconcile` (or nothing, when already at rest).
 *
 * - **Never installs.** When `reconcile()` reports packages beyond the
 *   declared manifest, this function returns a `"drifted"` result — it never
 *   calls any operation that would remove or otherwise correct them
 *   (invariants #4, #5: reconcile only closes gaps and never auto-corrects
 *   drift; that requires an approved, separate action).
 * - **Never revives an archived machine.** Desired state going from
 *   `"archived"` back to `"live"` is a restore, which is approval-gated and
 *   escalates through data/config/full modes (`docs/lifecycle.md`, unit 12)
 *   — not something an unattended reconcile pass should do by calling
 *   `create()` again. This surfaces as `ReconcileError`.
 */
export const reconcileMachine = (
  desired: DesiredMachineState,
  lastKnown: MachineStatus | null,
): Effect.Effect<
  ReconcileMachineResult,
  ProvisioningError | ReconcileError,
  ProvisioningServiceTag
> =>
  Effect.gen(function* () {
    const provisioning = yield* ProvisioningServiceTag;

    if (desired.lifecycle === "archived") {
      if (lastKnown === null || lastKnown.state === "archived" || lastKnown.state === "missing") {
        // Nothing live exists to archive — already at the desired rest state.
        return {
          machineId: desired.machineId,
          action: {
            kind: "already_archived",
            status: lastKnown ?? {
              machineId: desired.machineId,
              state: "archived",
              externalId: null,
            },
          },
        } satisfies ReconcileMachineResult;
      }

      const status = yield* provisioning.archive(desired.machineId, desired.provider);
      return {
        machineId: desired.machineId,
        action: { kind: "archived", status },
      } satisfies ReconcileMachineResult;
    }

    // desired.lifecycle === "live"
    if (lastKnown === null || lastKnown.state === "missing") {
      const status = yield* provisioning.create({
        machineId: desired.machineId,
        orgId: desired.orgId,
        provider: desired.provider,
        region: desired.region,
        sizeSku: desired.sizeSku,
        packages: desired.packages,
      });
      return {
        machineId: desired.machineId,
        action: { kind: "created", status },
      } satisfies ReconcileMachineResult;
    }

    if (lastKnown.state === "archived") {
      return yield* Effect.fail(
        new ReconcileError({ reason: "archived_requires_restore", machineId: desired.machineId }),
      );
    }

    const status = yield* provisioning.reconcile(desired.machineId, desired.provider);
    const undeclaredPackages = diffUndeclaredPackages(
      desired.packages,
      status.reportedPackages ?? [],
    );

    if (undeclaredPackages.length > 0) {
      return {
        machineId: desired.machineId,
        action: { kind: "drifted", status, undeclaredPackages },
      } satisfies ReconcileMachineResult;
    }

    return {
      machineId: desired.machineId,
      action: { kind: "in_sync", status },
    } satisfies ReconcileMachineResult;
  });
