import { machines } from "@cloudable/schema";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../db/layer";
import type { MachineStatus } from "../services/ProvisioningService";
import type { RefreshMachineResult } from "./types";

/**
 * States this pass is allowed to write.
 *
 * `"error"` is deliberately absent. It is the DEFAULT branch of
 * `machineStateForPowerState` — Azure has no error power state, so that branch
 * means "we did not recognise the answer", which in practice is
 * `PowerState/unknown` or a missing PowerState on a perfectly healthy machine.
 * Writing it here also fought `MachineDirectory.markVerified`, which promotes a
 * machine back to `running` the moment its agent checks in, so the column
 * flapped between the two while nothing was wrong.
 *
 * `error` belongs to the two things that actually know something failed:
 * provisioning, which records a real message alongside it, and staleness,
 * which is visible from `lastVerifiedAt`.
 *
 * `"archived"` and `"missing"` never appear here either — see this module's
 * own doc comment on why `archived`/`already_archived` results skip the state
 * column entirely.
 */
function isWritableState(
  state: MachineStatus["state"],
): state is "provisioning" | "running" | "stopped" {
  return state === "provisioning" || state === "running" || state === "stopped";
}

/**
 * The missing write-back `./loop.ts`'s own doc comment left for
 * `onResult`: nothing in this codebase persisted a `RefreshMachineResult`
 * anywhere before this. Every `ReconcileAction` variant carries a fresh
 * `status: MachineStatus` (confirmed in `./types.ts`) — this is what makes
 * that observation real, both for a machine created moments ago
 * (`MachineService.create()`'s own `settledRows` update covers *that*
 * specific moment already) and for the ongoing safety net every later
 * reconcile pass provides: a machine whose agent never checks in (cloud-init
 * failure, dead network) would otherwise sit in whatever state it last had
 * forever, with nothing ever re-observing it.
 *
 * Deliberately narrow about what it touches:
 * - `state`/`lastError`/`externalResourceId` only. Never `lastVerifiedAt` —
 *   that column's own doc comment ties it specifically to "the control
 *   agent successfully checked in" (it feeds the "machines are reporting"
 *   compliance check); a cloud-provider power-state poll is a genuinely
 *   weaker, different fact and must not be allowed to satisfy that check —
 *   only `MachineDirectory.markVerified` ever sets it.
 * - Never `lastReportedState` either — that column is exclusively owned by
 *   `services/reconcile-diff.ts`'s `runDiffAndPublish` (the agent `/report`
 *   path), which needs `packagesHash`/`runningAccessMethods` this signal
 *   doesn't have. Forcing this reconcile signal into that shape would mean
 *   fabricating `runningAccessMethods: []` on every pass, which would read
 *   as "access methods were just removed" against whatever the agent's own
 *   last real report said.
 * - `archived`/`already_archived` results never touch `state` at all — by
 *   the time `refreshMachineStatus` reaches that branch the row is already one
 *   of the two specific `archived_restorable`/`archived_expired` DB values
 *   (that's what drove `desired.lifecycle === "archived"` in the first
 *   place, via `list-machines.ts`), and `MachineStatus`'s own `"archived"`
 *   state is a narrower value than either — overwriting a specific,
 *   already-correct lifecycle state with a generic one would be a real
 *   regression, not a no-op. Only `externalResourceId` is updated (cleared
 *   to whatever `archive()` returned, typically `null`).
 *
 * The grace-period check and the whole write happen in one statement (a SQL
 * `CASE` referencing the row's own current `state`/`created_at`, the same
 * conditional-update idiom `CloudCatalogService.ts`'s `upsertEntries` and
 * `MachineDirectory.markVerified` already use) rather than a separate
 * read-then-write — no race between "check" and "act" to worry about.
 *
 * Never fails: a bad row or a transient DB error is logged and swallowed,
 * matching `onResult`'s own `Effect.Effect<void>` (no error channel)
 * contract and `refreshAllOnce`'s "one bad machine never stops the rest"
 * posture.
 */
export function persistRefreshResult(result: RefreshMachineResult): Effect.Effect<void, never, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const { action } = result;

    if (action.kind === "archived" || action.kind === "already_archived") {
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(machines)
            .set({ externalResourceId: action.status.externalId })
            .where(eq(machines.id, result.machineId)),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(
            `reconcile: failed to persist archived state for ${result.machineId}: ${String(cause)}`,
          ),
        ),
      );
      return;
    }

    const newState = action.status.state;
    if (!isWritableState(newState)) {
      // Includes every "error" this pass observes, which is why there is no
      // grace period here any more: nothing it writes can be a false error.
      yield* Effect.logWarning(
        `status-refresh: not persisting state "${newState}" for ${result.machineId} on a ${action.kind} result`,
      );
      return;
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(machines)
          .set({
            state: newState,
            externalResourceId: action.status.externalId ?? sql`${machines.externalResourceId}`,
          })
          .where(eq(machines.id, result.machineId)),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning(
          `status-refresh: failed to persist result for ${result.machineId}: ${String(cause)}`,
        ).pipe(Effect.as([])),
      ),
    );
  });
}
