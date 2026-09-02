import { machines } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect, Layer } from "effect";
import { ulid } from "ulid";
import { Db } from "../db/layer";
import { deriveEvents } from "../domain/machine/events";
import type { MachineLastKnownState, MachineReportedState } from "../domain/machine/types";
import { EventBus } from "./EventBus";

export class ReconcileDiffError extends Data.TaggedError("ReconcileDiffError")<{
  reason: "machine_not_found" | "load_failed" | "persist_failed";
  cause?: unknown;
}> {}

/**
 * Narrow, structural check — `machines.lastReportedState` is untyped
 * `jsonb`. A row persisted before `runningAccessMethods` existed on this
 * shape fails this check and is treated as `previous: undefined`, so the
 * next report re-emits one `machine.first_seen` for that machine — the
 * same accepted, documented false positive `http/handlers/agent-protocol.ts`'s
 * in-memory diff cache already causes across a control-plane restart,
 * rather than risking a crash from spreading a missing field.
 */
function isMachineLastKnownState(value: unknown): value is MachineLastKnownState {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "packagesHash" in value &&
    "undeclaredPackages" in value &&
    "externalResourceId" in value &&
    "runningAccessMethods" in value
  );
}

/**
 * Thin Effect wrapper around `deriveEvents` (see `../domain/machine/events`)
 * — the integration point unit 1's reconcile loop and unit 3's agent
 * `/report` handler are expected to call after they've obtained a
 * `MachineReportedState` from the agent, instead of emitting events ad hoc.
 *
 * Everything below runs inside a single Postgres transaction, `SELECT ...
 * FOR UPDATE`-locking the machine's row for its duration. Without that,
 * "load previous state, derive events, publish, then persist new state" is
 * four separate round-trips: a crash between publish and persist (or two
 * concurrent reports for the same machine, e.g. an agent retry) would both
 * read the same `previous`, both derive and publish the same events, and —
 * because `events` is append-only, nothing can later delete
 * the duplicate — permanently double the audit trail for one real change.
 * The row lock plus one transaction makes the whole diff-publish-persist
 * cycle atomic and serializes concurrent reports for the same machine.
 *
 * `EventBus.publish` remains the only code path that writes to `events`
 * (per its own doc comment) — including here: rather than inserting
 * directly against the transaction, this builds a transaction-scoped
 * `EventBus` (same service, `Db` swapped for the open transaction handle)
 * and calls `publish` on that, so id/recordedAt assignment stays
 * centralized in one place.
 *
 * 1. Loads the machine's `orgId` and last-reported state (`machines.lastReportedState`,
 *    a `jsonb` column added by this unit — see the doc comment on that
 *    column in `packages/schema/src/tables/machine.ts` for why a new column
 *    on `machines` was chosen over a dedicated table: it's a 1:1
 *    relationship, and `null` already means exactly "never reported").
 * 2. Calls `deriveEvents(previous, reported, ctx)`.
 * 3. Publishes the result via a transaction-scoped `EventBus.publish` — but
 *    only when non-empty; `publish` already no-ops on an empty batch, but
 *    skipping the call entirely avoids depending on that.
 * 4. Persists `reported` as the new `lastReportedState`, and bumps
 *    `lastVerifiedAt` to `occurredAt` (the "machines are reporting"
 *    compliance check's freshness signal, per `machines.lastVerifiedAt`'s
 *    doc comment).
 *
 * `correlationId` and `occurredAt` are optional overrides for callers that
 * already have one (e.g. one HTTP request handling both a `/report` call
 * and other work under a shared correlation id) — omit them and this
 * generates a fresh correlation id and uses "now", which is the right
 * default for a standalone report.
 */
export const runDiffAndPublish = (
  machineId: string,
  reported: MachineReportedState,
  overrides?: { correlationId?: string; occurredAt?: Date },
): Effect.Effect<void, ReconcileDiffError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const rows = await tx
            .select({ orgId: machines.orgId, lastReportedState: machines.lastReportedState })
            .from(machines)
            .where(eq(machines.id, machineId))
            .for("update")
            .limit(1);

          const row = rows[0];
          if (!row) {
            throw new ReconcileDiffError({ reason: "machine_not_found" });
          }

          const previous = isMachineLastKnownState(row.lastReportedState)
            ? row.lastReportedState
            : undefined;
          const occurredAt = overrides?.occurredAt ?? new Date();
          const correlationId = overrides?.correlationId ?? ulid();

          const derivedEvents = deriveEvents(previous, reported, {
            orgId: row.orgId,
            machineId,
            correlationId,
            occurredAt,
          });

          if (derivedEvents.length > 0) {
            // `tx` structurally satisfies `Db`'s `PostgresJsDatabase<typeof schema>`
            // (both are `PgDatabase` subtypes over the same schema/query-result
            // shape) — this is what scopes `EventBus.publish` to this transaction.
            const txLayer = EventBus.Default.pipe(
              Layer.provideMerge(
                Layer.succeed(Db, tx as unknown as PostgresJsDatabase<typeof schema>),
              ),
            );
            await Effect.runPromise(
              Effect.provide(
                Effect.gen(function* () {
                  const eventBus = yield* EventBus;
                  yield* eventBus.publish(derivedEvents);
                }),
                txLayer,
              ),
            );
          }

          await tx
            .update(machines)
            .set({ lastReportedState: reported, lastVerifiedAt: occurredAt })
            .where(eq(machines.id, machineId));
        }),
      catch: (cause) =>
        cause instanceof ReconcileDiffError
          ? cause
          : new ReconcileDiffError({ reason: "persist_failed", cause }),
    });
  });
