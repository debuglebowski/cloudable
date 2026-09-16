import { Data, Effect } from "effect";
import {
  type MachineStatus,
  type ProvisioningError,
  ProvisioningServiceTag,
} from "../services/ProvisioningService";
import type { DesiredMachineState, RefreshMachineResult } from "./types";

export class StatusRefreshError extends Data.TaggedError("StatusRefreshError")<{
  reason: "archived_requires_restore";
  machineId: string;
}> {
  /** Same reasoning as `ProvisioningError`'s: without this, every renderer prints the
   * tag alone and the fields that identify the failure are lost. */
  override get message(): string {
    return `${this.reason} (machine ${this.machineId})`;
  }
}

/**
 * Re-observes one machine's real state through the provider, and archives one
 * whose desired lifecycle says it should be gone.
 *
 * This is a safety net, not a control loop. It exists because a machine whose
 * agent never checks in — cloud-init failed, network is dead — would otherwise
 * sit at whatever state creation left it in forever, with nothing ever looking
 * again. Everything else about a machine's state comes from the agent.
 *
 * - **It changes no software.** Packages are permission plus explicit
 *   per-package actions now; this pass neither installs, removes, nor compares
 *   anything about them.
 * - **It never revives an archived machine.** Desired state going from
 *   `"archived"` back to `"live"` is a restore, which is approval-gated and
 *   escalates through data/config/full modes (`docs/lifecycle.md`) — not
 *   something an unattended pass should do by calling `create()` again. This
 *   surfaces as `StatusRefreshError`.
 */
export const refreshMachineStatus = (
  desired: DesiredMachineState,
  lastKnown: MachineStatus | null,
): Effect.Effect<
  RefreshMachineResult,
  ProvisioningError | StatusRefreshError,
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
        } satisfies RefreshMachineResult;
      }

      const status = yield* provisioning.archive(
        desired.machineId,
        desired.provider,
        lastKnown.externalId,
      );
      return {
        machineId: desired.machineId,
        action: { kind: "archived", status },
      } satisfies RefreshMachineResult;
    }

    // desired.lifecycle === "live"
    if (lastKnown === null || lastKnown.state === "missing") {
      const status = yield* provisioning.create({
        machineId: desired.machineId,
        orgId: desired.orgId,
        provider: desired.provider,
        region: desired.region,
        sizeSku: desired.sizeSku,
        // This pass declares no software. Packages are permission plus
        // explicit per-package actions, and neither reaches the provider here.
        packages: [],
      });
      return {
        machineId: desired.machineId,
        action: { kind: "created", status },
      } satisfies RefreshMachineResult;
    }

    if (lastKnown.state === "archived") {
      return yield* Effect.fail(
        new StatusRefreshError({
          reason: "archived_requires_restore",
          machineId: desired.machineId,
        }),
      );
    }

    const status = yield* provisioning.reconcile(
      desired.machineId,
      desired.provider,
      lastKnown.externalId,
    );
    return {
      machineId: desired.machineId,
      action: { kind: "observed", status },
    } satisfies RefreshMachineResult;
  });
