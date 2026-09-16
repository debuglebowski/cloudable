import type { Duration } from "effect";
import { Effect, Schedule } from "effect";
import type {
  MachineStatus,
  ProvisioningError,
  ProvisioningServiceTag,
} from "../services/ProvisioningService";
import { type StatusRefreshError, refreshMachineStatus } from "./refresh-machine";
import type { DesiredMachineState, RefreshMachineResult } from "./types";

/** One machine's desired state paired with its last-known observed status. */
export interface RefreshInput {
  desired: DesiredMachineState;
  lastKnown: MachineStatus | null;
}

export interface StatusRefreshLoopConfig<E, R> {
  /**
   * Lists every machine the loop should reconcile this pass, with its
   * desired state and last-known status. Deliberately abstract: this unit
   * owns reconciliation orchestration, not machine/desired-state
   * persistence (the `machines` + settings tables in `packages/schema`) —
   * wire a real implementation once that repository exists.
   */
  listMachines: Effect.Effect<ReadonlyArray<RefreshInput>, E, R>;
  /** Time between the end of one pass and the start of the next. */
  interval: Duration.DurationInput;
  /**
   * Called once per machine with its result. Optional — logging/metrics
   * only; turning results into `machine.drift_detected` etc. events is
   * unit 6's job — event derivation is pure and happens above the
   * provisioning port.
   */
  onResult?: (result: RefreshMachineResult) => Effect.Effect<void>;
  /** Called once per machine whose reconcile call failed this pass. */
  onError?: (
    machineId: string,
    error: ProvisioningError | StatusRefreshError,
  ) => Effect.Effect<void>;
}

/**
 * Runs one reconcile pass across every machine `listMachines` returns.
 *
 * A single machine's failure never aborts the pass or the caller's `Effect`
 * — it's caught and routed to `onError` so one bad machine can't starve the
 * rest of the fleet (or, in `runStatusRefreshLoop`, stop the loop itself).
 */
export const refreshAllOnce = <E, R>(
  config: StatusRefreshLoopConfig<E, R>,
): Effect.Effect<void, E, R | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const machines = yield* config.listMachines;

    yield* Effect.forEach(
      machines,
      ({ desired, lastKnown }) =>
        refreshMachineStatus(desired, lastKnown).pipe(
          Effect.tap((result) => config.onResult?.(result) ?? Effect.void),
          Effect.catchAll((error) => config.onError?.(desired.machineId, error) ?? Effect.void),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

/**
 * Repeats `refreshAllOnce` on a fixed spacing, forever, as an Effect
 * `Schedule`. Per-machine failures are already absorbed by `onError` inside
 * `refreshAllOnce`; only a failure in `listMachines` itself (the `E` type
 * parameter) can end the loop, since there is nothing meaningful left to
 * reconcile against.
 *
 * Callers decide how to run this — e.g. `Effect.forkDaemon` it during
 * server startup — since wiring it into `server.ts`/`layers.ts` belongs to
 * whichever unit owns application bootstrap for this loop.
 */
export const runStatusRefreshLoop = <E, R>(
  config: StatusRefreshLoopConfig<E, R>,
): Effect.Effect<void, E, R | ProvisioningServiceTag> =>
  refreshAllOnce(config).pipe(Effect.repeat(Schedule.spaced(config.interval)), Effect.asVoid);
