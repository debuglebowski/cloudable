import { events, orgs, settingValues, snapshots } from "@cloudable/schema";
import { and, asc, eq, gte, inArray, lt, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { toEventRows } from "../../services/EventBus";
import { SYSTEM_ACTOR, makeEnvelope } from "../archive/events";
import { EVENTS_RETENTION_DAYS_KEY, effectiveEventsRetentionDays } from "./policy";

export class EventRetentionError extends Data.TaggedError("EventRetentionError")<{
  reason: string;
  cause?: unknown;
}> {}

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * The most one org loses in one run, oldest first. A backlog (the first sweep after
 * retention is introduced, or a window that was just shortened) drains over successive
 * passes instead of as one enormous statement.
 */
export const MAX_EVENTS_DELETED_PER_RUN = 50_000;

const tryDb = <A>(thunk: () => Promise<A>, reason: string): Effect.Effect<A, EventRetentionError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new EventRetentionError({ reason, cause }),
  });

/**
 * Deletes one org's events that have aged out, and records that it did.
 *
 * WHAT COUNTS AS AGED OUT. An event is deleted once it is older than `retentionDays`,
 * with two exceptions that both protect a unit of evidence rather than a single row:
 *
 * - **A correlation group goes as a unit.** Everything one operation produced shares a
 *   `correlationId`, and the compliance checks read those events together
 *   (`elevated-access-approved` looks for the `approval.granted` that shares an
 *   elevation's correlation id). Cutting a group in two at the cutoff would leave a
 *   grant whose approval had just been deleted, and the check would report a missing
 *   approval for something that was approved. So an event is held back while ANY event
 *   in its group is still inside the window.
 * - **Legal hold.** An event of a machine that has a snapshot under legal hold is kept,
 *   and so is the rest of its group. A hold exists to preserve evidence; letting the
 *   machine's history age out underneath it would defeat that. Events with no machine
 *   (org-level) are not covered by a machine's hold.
 *
 * Both exceptions are one predicate: an event is protected when a sibling in its group
 * is inside the window or belongs to a held machine. The event itself is its own
 * sibling, so a held machine's own events are covered by the same clause.
 *
 * ATOMICITY. The delete and the `org.events_expired` record commit in one transaction.
 * A deletion with no record would leave an auditor looking at a gap they cannot
 * explain, and a record with no deletion would claim something that did not happen, so
 * neither is allowed to exist alone.
 *
 * The record carries the cutoff, the window and a count, never anything read from the
 * events it removed. It is tier 1, which `EventBus.publish` never filters, so inserting
 * it directly here skips nothing the bus would have applied.
 *
 * Known limit: a `correlationId` is whatever the caller supplied (config import accepts
 * one), so a client that reuses a single id for every call keeps that whole group alive
 * indefinitely. Every id the control plane generates itself is fresh per operation.
 *
 * Returns the number of events deleted.
 */
export const expireOrgEvents = (
  orgId: string,
  retentionDays: number,
  now: Date = new Date(),
): Effect.Effect<number, EventRetentionError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

    return yield* tryDb(
      () =>
        db.transaction(async (tx) => {
          const candidate = alias(events, "candidate");
          const sibling = alias(events, "sibling");

          const heldMachineIds = tx
            .select({ machineId: snapshots.machineId })
            .from(snapshots)
            .where(and(eq(snapshots.orgId, orgId), eq(snapshots.legalHold, true)));

          const expirable = tx
            .select({ id: candidate.id })
            .from(candidate)
            .where(
              and(
                eq(candidate.orgId, orgId),
                lt(candidate.occurredAt, cutoff),
                notExists(
                  tx
                    .select({ one: sql`1` })
                    .from(sibling)
                    .where(
                      and(
                        eq(sibling.orgId, candidate.orgId),
                        eq(sibling.correlationId, candidate.correlationId),
                        or(
                          gte(sibling.occurredAt, cutoff),
                          inArray(sibling.machineId, heldMachineIds),
                        ),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(candidate.occurredAt))
            .limit(MAX_EVENTS_DELETED_PER_RUN);

          const deleted = await tx
            .delete(events)
            .where(and(eq(events.orgId, orgId), inArray(events.id, expirable)))
            .returning({ id: events.id });

          if (deleted.length === 0) return 0;

          await tx.insert(events).values(
            toEventRows([
              {
                ...makeEnvelope({
                  orgId,
                  machineId: null,
                  correlationId: ulid(),
                  ...SYSTEM_ACTOR,
                }),
                type: "org.events_expired",
                payload: {
                  cutoff: cutoff.toISOString(),
                  retentionDays,
                  deletedCount: deleted.length,
                },
              },
            ]),
          );

          return deleted.length;
        }),
      "expire_org_events",
    );
  });

/**
 * One retention pass over every org: each org's own window (`events.retentionDays`,
 * default 365, never below 90), each org swept independently.
 *
 * A failure in one org is logged and does not stop the others. They share nothing but
 * this loop, and one org's broken row is no reason for another's evidence to outlive
 * its window.
 *
 * `onlyOrgIds` narrows the pass to those orgs. The daemon never passes it; it exists so
 * a test (or a one-off run for a single org) can sweep without touching every org in a
 * shared database.
 *
 * Returns the total deleted across orgs, which is what `runSweep` logs.
 */
export const expireEventsPastRetention = (
  now: Date = new Date(),
  onlyOrgIds?: ReadonlyArray<string>,
): Effect.Effect<number, EventRetentionError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const orgRows = yield* tryDb(
      () =>
        db
          .select({ id: orgs.id })
          .from(orgs)
          .where(onlyOrgIds ? inArray(orgs.id, [...onlyOrgIds]) : undefined),
      "list_orgs",
    );
    const settingRows = yield* tryDb(
      () =>
        db
          .select({ scopeId: settingValues.scopeId, value: settingValues.value })
          .from(settingValues)
          .where(
            and(
              eq(settingValues.key, EVENTS_RETENTION_DAYS_KEY),
              eq(settingValues.scopeType, "org"),
              onlyOrgIds ? inArray(settingValues.scopeId, [...onlyOrgIds]) : undefined,
            ),
          ),
      "read_retention_settings",
    );
    const storedByOrg = new Map(settingRows.map((row) => [row.scopeId, row.value]));

    let total = 0;
    for (const org of orgRows) {
      const retentionDays = effectiveEventsRetentionDays(storedByOrg.get(org.id));
      total += yield* expireOrgEvents(org.id, retentionDays, now).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `event retention: org ${org.id} failed this pass: ${error.reason}`,
          ).pipe(Effect.as(0)),
        ),
      );
    }
    return total;
  });
