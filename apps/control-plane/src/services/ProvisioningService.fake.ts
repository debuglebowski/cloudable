import { Effect, Layer, Ref } from "effect";
import {
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
} from "./ProvisioningService";

interface FakeMachineEntry {
  status: MachineStatus;
  /** Declared at `create()` time — see `MachineDescriptor.packages`. */
  declaredPackages: ReadonlyArray<string>;
}

export interface FakeProvisioningOptions {
  /**
   * Extra "installed" software to report on every subsequent `reconcile()`
   * call for a given machine id, standing in for what a real control agent
   * would observe running on the box (see `docs/agents.md`). This is how
   * tests and demos give the reconciliation loop (and, later, compliance
   * checks) real drift to detect — the fake never installs anything itself
   * (invariants #4, #5); it only ever reports what reconcile() would find.
   */
  simulatedExtraPackages?: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * In-memory `ProvisioningService` for dev/test — no real Azure account
 * exists in this build (see `ProvisioningService.azure.ts`). `create` moves
 * a machine through "provisioning" then "running" synchronously; `archive`
 * flips it to "archived"; `reconcile` only ever reports the machine's
 * current status plus its currently-observed packages (invariants #4, #5 —
 * never installs, never auto-corrects; see `src/reconcile/reconcile-machine.ts`
 * for the code that decides what counts as drift).
 */
export const makeFakeProvisioningServiceLive = (
  options: FakeProvisioningOptions = {},
): Layer.Layer<ProvisioningServiceTag> =>
  Layer.effect(
    ProvisioningServiceTag,
    Effect.gen(function* () {
      const state = yield* Ref.make(new Map<string, FakeMachineEntry>());

      const require = (machineId: string): Effect.Effect<FakeMachineEntry, ProvisioningError> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const existing = current.get(machineId);
          if (!existing) {
            return yield* Effect.fail(
              new ProvisioningError({
                reason: "not_found",
                cause: `unknown machineId: ${machineId}`,
              }),
            );
          }
          return existing;
        });

      const reportedPackagesFor = (machineId: string, declaredPackages: ReadonlyArray<string>) => [
        ...declaredPackages,
        ...(options.simulatedExtraPackages?.get(machineId) ?? []),
      ];

      const create: ProvisioningService["create"] = (desc: MachineDescriptor) =>
        Effect.gen(function* () {
          const declaredPackages = desc.packages ?? [];

          const provisioning: FakeMachineEntry = {
            status: { machineId: desc.machineId, state: "provisioning", externalId: null },
            declaredPackages,
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, provisioning));

          const running: FakeMachineEntry = {
            status: {
              machineId: desc.machineId,
              state: "running",
              externalId: `fake-${desc.machineId}`,
              reportedPackages: reportedPackagesFor(desc.machineId, declaredPackages),
            },
            declaredPackages,
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, running));

          return running.status;
        });

      const archive: ProvisioningService["archive"] = (machineId: string) =>
        Effect.gen(function* () {
          const existing = yield* require(machineId);
          const archived: FakeMachineEntry = {
            ...existing,
            status: { ...existing.status, state: "archived" },
          };
          yield* Ref.update(state, (map) => new Map(map).set(machineId, archived));
          return archived.status;
        });

      const reconcile: ProvisioningService["reconcile"] = (machineId: string) =>
        Effect.gen(function* () {
          const existing = yield* require(machineId);
          if (existing.status.state === "archived") {
            // Nothing to observe on an archived machine — report as-is.
            return existing.status;
          }
          return {
            ...existing.status,
            reportedPackages: reportedPackagesFor(machineId, existing.declaredPackages),
          } satisfies MachineStatus;
        });

      return { create, archive, reconcile } satisfies ProvisioningService;
    }),
  );

export const FakeProvisioningServiceLive = makeFakeProvisioningServiceLive();
