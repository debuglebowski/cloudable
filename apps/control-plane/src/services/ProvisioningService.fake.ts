import { Effect, Layer, Ref } from "effect";
import {
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
} from "./ProvisioningService";

/**
 * In-memory `ProvisioningService` for dev/test — no real Azure account
 * exists in this build (see `ProvisioningService.azure.ts`). `create` moves
 * a machine through "provisioning" then "running" synchronously; `archive`
 * flips it to "archived"; `reconcile` only ever reports the machine's
 * current status (invariants #4, #5 — never installs, never auto-corrects).
 */
export const FakeProvisioningServiceLive = Layer.effect(
  ProvisioningServiceTag,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, MachineStatus>());

    const require = (machineId: string): Effect.Effect<MachineStatus, ProvisioningError> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const existing = current.get(machineId);
        if (!existing) {
          return yield* Effect.fail(
            new ProvisioningError({ reason: "not_found", cause: `unknown machineId: ${machineId}` }),
          );
        }
        return existing;
      });

    const create: ProvisioningService["create"] = (desc: MachineDescriptor) =>
      Effect.gen(function* () {
        const provisioning: MachineStatus = {
          machineId: desc.machineId,
          state: "provisioning",
          externalId: null,
        };
        yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, provisioning));

        const running: MachineStatus = {
          machineId: desc.machineId,
          state: "running",
          externalId: `fake-${desc.machineId}`,
        };
        yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, running));

        return running;
      });

    const archive: ProvisioningService["archive"] = (machineId: string) =>
      Effect.gen(function* () {
        const existing = yield* require(machineId);
        const archived: MachineStatus = { ...existing, state: "archived" };
        yield* Ref.update(state, (map) => new Map(map).set(machineId, archived));
        return archived;
      });

    const reconcile: ProvisioningService["reconcile"] = (machineId: string) => require(machineId);

    return { create, archive, reconcile } satisfies ProvisioningService;
  }),
);
