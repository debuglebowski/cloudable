import type { Duration } from "effect";
import { Effect, Schedule } from "effect";
import type { ProvisioningError, ProvisioningServiceTag } from "../services/ProvisioningService";
import type { MachineStatus } from "../services/ProvisioningService";
import { type ReconcileError, reconcileMachine } from "./reconcile-machine";
import type { DesiredMachineState, ReconcileMachineResult } from "./types";

/** One machine's desired state paired with its last-known observed status. */
export interface ReconcileInput {
  desired: DesiredMachineState;
  lastKnown: MachineStatus | null;
}

export interface ReconcileLoopConfig<E, R> {
  /**
   * Lists every machine the loop should reconcile this pass, with its
   * desired state and last-known status. Deliberately abstract: this unit
   * owns reconciliation orchestration, not machine/desired-state
   * persistence (the `machines` + settings tables in `packages/schema`) —
   * wire a real implementation once that repository exists.
   */
  listMachines: Effect.Effect<ReadonlyArray<ReconcileInput>, E, R>;
  /** Time between the end of one pass and the start of the next. */
  interval: Duration.DurationInput;
  /**
   * Called once per machine with its result. Optional — logging/metrics
   * only; turning results into `machine.drift_detected` etc. events is
   * unit 6's job (event derivation is pure and happens above the
   * provisioning port, per `docs/spec.md` §23).
   */
  onResult?: (result: ReconcileMachineResult) => Effect.Effect<void>;
  /** Called once per machine whose reconcile call failed this pass. */
  onError?: (machineId: string, error: ProvisioningError | ReconcileError) => Effect.Effect<void>;
}

/**
 * Runs one reconcile pass across every machine `listMachines` returns.
 *
 * A single machine's failure never aborts the pass or the caller's `Effect`
 * — it's caught and routed to `onError` so one bad machine can't starve the
 * rest of the fleet (or, in `runReconcileLoop`, stop the loop itself).
 */
export const reconcileAllOnce = <E, R>(
  config: ReconcileLoopConfig<E, R>,
): Effect.Effect<void, E, R | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const machines = yield* config.listMachines;

    yield* Effect.forEach(
      machines,
      ({ desired, lastKnown }) =>
        reconcileMachine(desired, lastKnown).pipe(
          Effect.tap((result) => config.onResult?.(result) ?? Effect.void),
          Effect.catchAll((error) => config.onError?.(desired.machineId, error) ?? Effect.void),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

/**
 * Repeats `reconcileAllOnce` on a fixed spacing, forever, as an Effect
 * `Schedule`. Per-machine failures are already absorbed by `onError` inside
 * `reconcileAllOnce`; only a failure in `listMachines` itself (the `E` type
 * parameter) can end the loop, since there is nothing meaningful left to
 * reconcile against.
 *
 * Callers decide how to run this — e.g. `Effect.forkDaemon` it during
 * server startup — since wiring it into `server.ts`/`layers.ts` belongs to
 * whichever unit owns application bootstrap for this loop.
 */
export const runReconcileLoop = <E, R>(
  config: ReconcileLoopConfig<E, R>,
): Effect.Effect<void, E, R | ProvisioningServiceTag> =>
  reconcileAllOnce(config).pipe(Effect.repeat(Schedule.spaced(config.interval)), Effect.asVoid);
