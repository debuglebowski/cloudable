import { machines } from "@cloudable/schema";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { MachineService } from "../domain/machine/MachineService";
import type { MachineStatus } from "../services/ProvisioningService";
import type { ReconcileInput } from "./loop";

/** Mirrors `archive/sub-state.ts`'s own list — kept separate (not imported) since that
 * module's states carry archive-lifecycle meaning this file doesn't need. */
const ARCHIVED_DB_STATES = new Set(["archived_restorable", "archived_expired"]);

/** Maps this build's 6 DB machine states onto `ProvisioningService`'s narrower 5-value
 * `MachineStatus.state` — `"stopped"` has no real equivalent yet (nothing in this build
 * transitions a machine there outside the offboarding sequence, which archives it in the
 * same step) so it's treated as `"running"`: reconcile still checks it against
 * provisioning rather than silently skipping it. */
function toLastKnownStatus(row: {
  id: string;
  state: string;
  externalResourceId: string | null;
}): MachineStatus {
  const state: MachineStatus["state"] = ARCHIVED_DB_STATES.has(row.state)
    ? "archived"
    : row.state === "error"
      ? "error"
      : row.state === "provisioning"
        ? "provisioning"
        : "running";
  return { machineId: row.id, state, externalId: row.externalResourceId };
}

/**
 * Real `ReconcileLoopConfig["listMachines"]` — `reconcile/loop.ts`'s own doc
 * comment left this deliberately unimplemented ("wire a real implementation
 * once that repository exists"); it does now (`MachineService`).
 *
 * `E = never`: a transient failure reading the fleet must not end the whole
 * daemon loop (`runReconcileLoop` only stops on a `listMachines` failure,
 * per its own doc comment) — logged and skipped for this pass instead, same
 * posture as a single machine's own reconcile failure (`reconcileAllOnce`'s
 * `onError`).
 */
export const listReconcilableMachines: Effect.Effect<
  ReadonlyArray<ReconcileInput>,
  never,
  Db | MachineService
> = Effect.gen(function* () {
  const db = yield* Db;
  const machineService = yield* MachineService;

  const rows = yield* Effect.tryPromise({
    try: () => db.select().from(machines),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logError(`reconcile: failed to list machines: ${String(cause)}`).pipe(
        Effect.as([] as (typeof machines.$inferSelect)[]),
      ),
    ),
  );

  const inputs = yield* Effect.forEach(
    rows,
    (row) =>
      machineService.getById(row.id, row.orgId).pipe(
        Effect.map(
          (detail): ReconcileInput => ({
            desired: {
              machineId: detail.id,
              orgId: detail.orgId,
              provider: detail.provider,
              region: detail.region,
              sizeSku: detail.sizeSku,
              packages: detail.manifest.map((entry) => entry.packageName),
              lifecycle: ARCHIVED_DB_STATES.has(detail.state) ? "archived" : "live",
            },
            lastKnown: toLastKnownStatus(detail),
          }),
        ),
        Effect.catchAll((cause) =>
          Effect.logError(`reconcile: skipping machine ${row.id} this pass: ${String(cause)}`).pipe(
            Effect.as(null),
          ),
        ),
      ),
    // Sequential, not "unbounded": this loop's own concurrency budget is
    // spent on machines in parallel already (`reconcileAllOnce`) — no need
    // to also fan out N simultaneous `getById` reads on top of that for a
    // background pass with no latency deadline.
    { concurrency: 4 },
  );

  return inputs.filter((input): input is ReconcileInput => input !== null);
});
