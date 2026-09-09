import { machines } from "@cloudable/schema";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../db/layer";
import { machineDriftDetectedEvent } from "../domain/machine/events";
import { EventBus } from "../services/EventBus";
import type { MachineStatus } from "../services/ProvisioningService";
import type { ReconcileMachineResult } from "./types";

/**
 * How long a freshly-created machine gets before a reconcile pass observing
 * anything other than "running" is trusted at face value.
 *
 * `ProvisioningService.azure.ts`'s `reconcile()` reports `state: "error"` for
 * *any* non-`"running"` Azure power state — there's no "still starting"
 * state in that adapter. A reconcile pass can land in the narrow window
 * between VM creation and the hypervisor actually reporting
 * `PowerState/running`, which would otherwise write a false "error" onto a
 * machine that's actually fine. 3 minutes comfortably covers ARM
 * finalization + OS boot + cloud-init (binary download, systemd unit,
 * service start) + one ~30s agent poll cycle, with real margin — see
 * `docs/agents.md` for the agent's own poll cadence.
 */
const PROVISIONING_GRACE_PERIOD_SQL = sql`interval '3 minutes'`;

/** The three `MachineStatus` states that can legitimately reach this
 * function via the `created`/`in_sync`/`drifted` result kinds — `"archived"`
 * and `"missing"` never appear here (see this module's own doc comment on
 * why `archived`/`already_archived` results skip the state column
 * entirely). */
function isWritableState(
  state: MachineStatus["state"],
): state is "provisioning" | "running" | "error" {
  return state === "provisioning" || state === "running" || state === "error";
}

/**
 * The missing write-back `reconcile/loop.ts`'s own doc comment left for
 * `onResult`: nothing in this codebase persisted a `ReconcileMachineResult`
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
 *   the time `reconcileMachine` reaches that branch the row is already one
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
 * contract and `reconcileAllOnce`'s "one bad machine never stops the rest"
 * posture.
 */
export function persistReconcileResult(
  result: ReconcileMachineResult,
): Effect.Effect<void, never, Db | EventBus> {
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
      yield* Effect.logWarning(
        `reconcile: unexpected status.state "${newState}" for ${result.machineId} on a ${action.kind} result — not persisted`,
      );
      return;
    }
    const newLastError = newState === "error" ? `provider reconcile reported state "error"` : null;

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .update(machines)
          .set({
            state: sql`CASE
              WHEN ${machines.state} = 'provisioning'
                AND ${newState} = 'error'
                AND now() - ${machines.createdAt} < ${PROVISIONING_GRACE_PERIOD_SQL}
              THEN ${machines.state}
              ELSE ${newState}
            END`,
            lastError: sql`CASE
              WHEN ${machines.state} = 'provisioning'
                AND ${newState} = 'error'
                AND now() - ${machines.createdAt} < ${PROVISIONING_GRACE_PERIOD_SQL}
              THEN ${machines.lastError}
              ELSE ${newLastError}
            END`,
            externalResourceId: action.status.externalId ?? sql`${machines.externalResourceId}`,
          })
          .where(eq(machines.id, result.machineId))
          .returning({ orgId: machines.orgId }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning(
          `reconcile: failed to persist result for ${result.machineId}: ${String(cause)}`,
        ).pipe(Effect.as([])),
      ),
    );

    const orgId = rows[0]?.orgId;
    if (!orgId || action.kind !== "drifted") return;

    const eventBus = yield* EventBus;
    yield* eventBus
      .publish([
        machineDriftDetectedEvent({
          machineId: result.machineId,
          orgId,
          correlationId: ulid(),
          actorType: "system",
          actorId: "reconcile-loop",
          undeclaredPackages: action.undeclaredPackages,
        }),
      ])
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(
            `reconcile: failed to publish drift event for ${result.machineId}: ${String(cause)}`,
          ),
        ),
      );
  });
}
