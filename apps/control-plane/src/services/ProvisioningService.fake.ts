import { Effect, Layer, Ref } from "effect";
import {
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
  type ReimageDescriptor,
} from "./ProvisioningService";

/**
 * Dev/test-only sentinel `targetImage`: reimaging to this value (via unit
 * 18's `upgradeMachine`) lands the fake machine in `"error"` state instead
 * of `"running"`, so the subsequent `reconcile()` call — the "verify
 * declared state" step — reports a mismatch. This is how the transactional
 * upgrade rollback path is exercised end-to-end (unit tests and manual
 * `curl` verification) without a real Azure account. It is not a real image
 * name and `ProvisioningService.azure.ts` has no matching behavior.
 */
export const FAKE_VERIFICATION_FAILURE_IMAGE = "cloudable/dev-force-verification-failure";

/**
 * In-memory `ProvisioningService` for dev/test — no real Azure account
 * exists in this build (see `ProvisioningService.azure.ts`). `create` moves
 * a machine through "provisioning" then "running" synchronously; `archive`
 * flips it to "archived"; `reconcile` only ever reports the machine's
 * current status (invariants #4, #5 — never installs, never auto-corrects);
 * `reimage` (unit 18) moves it through "provisioning" then back to
 * "running" — unless `targetImage` is `FAKE_VERIFICATION_FAILURE_IMAGE`, in
 * which case it settles on "error" to simulate a machine that came up
 * broken/drifted post-reimage.
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

    const reimage: ProvisioningService["reimage"] = (desc: ReimageDescriptor) =>
      Effect.gen(function* () {
        const existing = yield* require(desc.machineId);

        const provisioning: MachineStatus = { ...existing, state: "provisioning" };
        yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, provisioning));

        const finalState: MachineStatus["state"] =
          desc.targetImage === FAKE_VERIFICATION_FAILURE_IMAGE ? "error" : "running";
        const settled: MachineStatus = { ...existing, state: finalState };
        yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, settled));

        return settled;
      });

    return { create, archive, reconcile, reimage } satisfies ProvisioningService;
  }),
);
