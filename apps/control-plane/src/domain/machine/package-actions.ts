import { isValidPackageName } from "@cloudable/contracts";
import type { PackageActionOp, PendingPackageActionView } from "@cloudable/contracts";
import { machinePackageActions } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";

type DbHandle = PostgresJsDatabase<typeof schema>;

export class PackageActionError extends Data.TaggedError("PackageActionError")<{
  reason:
    | "invalid_package_name"
    | "baseline_package"
    | "already_pending"
    | "machine_not_found"
    | "write_failed";
  message: string;
  cause?: unknown;
}> {}

/**
 * How long a collected action may go without a result before it is given up on.
 *
 * The clock starts when a poll hands the action to the agent, not when it was
 * requested: a machine that is asleep or polling slowly has not failed at
 * anything. Five minutes is comfortably longer than any `apt-get install` on a
 * reasonable connection and short enough that a dead agent does not leave a
 * row spinning all day.
 *
 * Expiry never retries. The package may be half-installed, and silently
 * running the package manager again over an unknown state is not something to
 * do without a person asking.
 */
export const ACTION_EXPIRY_MS = 5 * 60 * 1000;

export type ActionRow = typeof machinePackageActions.$inferSelect;

const COLLECTABLE = ["pending"] as const;
/** Statuses that block a second request for the same package. */
const OUTSTANDING = ["pending", "running"] as const;

export const toActionView = (row: ActionRow): PendingPackageActionView => ({
  id: row.id,
  op: row.op,
  status: row.status,
  requestedAt: row.requestedAt.toISOString(),
  ...(row.failureReason ? { failureReason: row.failureReason } : {}),
});

/**
 * Records a request to install or uninstall one package, and bumps the
 * machine's desired-state version so the agent's next poll is a 200 rather
 * than a 304.
 *
 * Validates the package name here as well as at the HTTP edge and again in the
 * agent. Three checks for one value looks redundant until you notice the agent
 * runs as root: this string ends up as an argument to the package manager, and
 * each layer can be reached without the one above it in a future refactor.
 *
 * Refuses a package that came with the image. Uninstalling `systemd` through a
 * button with no undo is not a capability worth having, and an install of
 * something already in the baseline is a no-op dressed up as an action.
 */
export const enqueuePackageAction = (
  db: DbHandle,
  input: {
    machineId: string;
    orgId: string;
    packageName: string;
    op: PackageActionOp;
    versionPin: string | null;
    requestedByPersonId: string;
    correlationId: string;
    isBaselinePackage: boolean;
  },
): Effect.Effect<ActionRow, PackageActionError> =>
  Effect.gen(function* () {
    if (!isValidPackageName(input.packageName)) {
      return yield* Effect.fail(
        new PackageActionError({
          reason: "invalid_package_name",
          message: `"${input.packageName}" is not a valid package name.`,
        }),
      );
    }

    if (input.isBaselinePackage) {
      return yield* Effect.fail(
        new PackageActionError({
          reason: "baseline_package",
          message: `"${input.packageName}" came with this machine's image and cannot be installed or removed from here.`,
        }),
      );
    }

    const outstanding = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: machinePackageActions.id })
          .from(machinePackageActions)
          .where(
            and(
              eq(machinePackageActions.machineId, input.machineId),
              eq(machinePackageActions.packageName, input.packageName),
              inArray(machinePackageActions.status, [...OUTSTANDING]),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new PackageActionError({
          reason: "write_failed",
          message: "checking for a pending action",
          cause,
        }),
    });

    if (outstanding.length > 0) {
      return yield* Effect.fail(
        new PackageActionError({
          reason: "already_pending",
          message: `"${input.packageName}" already has an action waiting on this machine.`,
        }),
      );
    }

    const rows = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const inserted = await tx
            .insert(machinePackageActions)
            .values({
              machineId: input.machineId,
              packageName: input.packageName,
              op: input.op,
              versionPin: input.versionPin,
              requestedByPersonId: input.requestedByPersonId,
              correlationId: input.correlationId,
            })
            .returning();
          // Same transaction as the insert: an action the agent can never be
          // told about is worse than no action at all.
          await tx.execute(
            sql`update machines set desired_state_version = desired_state_version + 1 where id = ${input.machineId}`,
          );
          return inserted;
        }),
      catch: (cause) =>
        new PackageActionError({ reason: "write_failed", message: "recording the action", cause }),
    });

    const row = rows[0];
    if (!row) {
      return yield* Effect.fail(
        new PackageActionError({ reason: "write_failed", message: "the action was not recorded" }),
      );
    }
    return row;
  });

/**
 * Hands this machine's pending actions to the agent and marks them running.
 *
 * Collect-once: the same `UPDATE ... RETURNING` both claims the rows and
 * returns them, so two polls racing (an agent retrying, or two control-plane
 * replicas) cannot hand the same install to the machine twice. Doing this as a
 * select followed by an update would leave exactly that gap.
 */
export const collectPendingActions = (
  db: DbHandle,
  machineId: string,
  now: Date,
): Effect.Effect<ActionRow[], PackageActionError> =>
  Effect.tryPromise({
    try: () =>
      db
        .update(machinePackageActions)
        .set({ status: "running", startedAt: now })
        .where(
          and(
            eq(machinePackageActions.machineId, machineId),
            inArray(machinePackageActions.status, [...COLLECTABLE]),
          ),
        )
        .returning(),
    catch: (cause) =>
      new PackageActionError({ reason: "write_failed", message: "collecting actions", cause }),
  });

export interface ActionOutcome {
  id: string;
  outcome: "succeeded" | "failed";
  detail?: string | undefined;
}

/**
 * Applies the outcomes an agent reported, and returns the rows that actually
 * changed so the caller can emit one event each.
 *
 * Scoped to the reporting machine's own actions, and only to rows still
 * `running`: an agent cannot resurrect an expired action, close one twice, or
 * say anything at all about another machine's work. The agent is reporting
 * observed state here, not writing history — the events are emitted by the
 * caller (invariant 12).
 */
export const applyActionResults = (
  db: DbHandle,
  machineId: string,
  results: ReadonlyArray<ActionOutcome>,
  now: Date,
): Effect.Effect<ActionRow[], PackageActionError> =>
  Effect.gen(function* () {
    if (results.length === 0) return [];

    const updated: ActionRow[] = [];
    for (const result of results) {
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .update(machinePackageActions)
            .set({
              status: result.outcome,
              finishedAt: now,
              failureReason: result.outcome === "failed" ? (result.detail ?? null) : null,
            })
            .where(
              and(
                eq(machinePackageActions.id, result.id),
                eq(machinePackageActions.machineId, machineId),
                eq(machinePackageActions.status, "running"),
              ),
            )
            .returning(),
        catch: (cause) =>
          new PackageActionError({
            reason: "write_failed",
            message: "recording an outcome",
            cause,
          }),
      });
      const row = rows[0];
      if (row) updated.push(row);
    }
    return updated;
  });

/**
 * Gives up on actions the agent collected and never reported back.
 *
 * Runs on the report path rather than as its own timer: a machine that is
 * reporting is a machine whose stuck actions we can judge, and one that is not
 * reporting has a bigger problem than a spinning row. Returns what it expired
 * so the caller can record it.
 */
export const expireStaleActions = (
  db: DbHandle,
  machineId: string,
  now: Date,
): Effect.Effect<ActionRow[], PackageActionError> =>
  Effect.tryPromise({
    try: () =>
      db
        .update(machinePackageActions)
        .set({ status: "expired", finishedAt: now })
        .where(
          and(
            eq(machinePackageActions.machineId, machineId),
            eq(machinePackageActions.status, "running"),
            lt(machinePackageActions.startedAt, new Date(now.getTime() - ACTION_EXPIRY_MS)),
          ),
        )
        .returning(),
    catch: (cause) =>
      new PackageActionError({ reason: "write_failed", message: "expiring actions", cause }),
  });

/** Outstanding actions for a machine, keyed by package name, for the table. */
export const outstandingActionsByPackage = (
  db: DbHandle,
  machineId: string,
): Effect.Effect<Map<string, PendingPackageActionView>, PackageActionError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(machinePackageActions)
          .where(
            and(
              eq(machinePackageActions.machineId, machineId),
              inArray(machinePackageActions.status, [...OUTSTANDING]),
            ),
          ),
      catch: (cause) =>
        new PackageActionError({ reason: "write_failed", message: "reading actions", cause }),
    });
    return new Map(rows.map((row) => [row.packageName, toActionView(row)]));
  });
