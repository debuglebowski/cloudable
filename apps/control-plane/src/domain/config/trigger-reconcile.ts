import { machines } from "@cloudable/schema";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { ConfirmationRequiredError, MachineNotFoundError, SettingWriteError } from "./errors";

export interface TriggerReconcileInput {
  /** Must match the target machine's own org — see comment on the `orgId` param below. */
  orgId: string;
  machineId: string;
  /** Must be exactly `true`. Absent or `false` is rejected — that's the confirmation gate. */
  confirm: boolean | undefined;
}

export interface TriggerReconcileResult {
  machineId: string;
  desiredStateVersion: number;
}

/**
 * The confirmation-gated action that marks a machine for reconciliation —
 * the only operation that mutates a machine, and it is confirmation-gated.
 *
 * This does NOT reconcile the machine itself — it only bumps
 * `machines.desiredStateVersion`, the version/ETag the agent poll
 * endpoint compares against to know there is new desired state to fetch.
 * The actual apply-on-next-poll behavior belongs to the reconcile
 * loop and poll endpoint; this function's only job is the confirmation gate
 * plus the version bump those units read.
 */
export const triggerReconcile = (
  input: TriggerReconcileInput,
): Effect.Effect<
  TriggerReconcileResult,
  ConfirmationRequiredError | MachineNotFoundError | SettingWriteError,
  Db
> =>
  Effect.gen(function* () {
    if (input.confirm !== true) {
      return yield* Effect.fail(
        new ConfirmationRequiredError({
          message:
            "reconcile requires an explicit { confirm: true } in the request body — it mutates a live machine",
        }),
      );
    }

    const db = yield* Db;
    // `orgId` is matched in the same WHERE as the id, atomically — not a
    // separate lookup-then-update — so this is also the tenant-isolation
    // check (invariant: a machine has exactly one owner/org). Wrong org and
    // missing machine both surface as the same 404, avoiding leaking
    // cross-org existence.
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .update(machines)
          .set({ desiredStateVersion: sql`${machines.desiredStateVersion} + 1` })
          .where(and(eq(machines.id, input.machineId), eq(machines.orgId, input.orgId)))
          .returning({ desiredStateVersion: machines.desiredStateVersion }),
      catch: (cause) =>
        new SettingWriteError({ message: `bumping desiredStateVersion: ${String(cause)}` }),
    });

    const row = rows[0];
    if (!row) {
      return yield* Effect.fail(new MachineNotFoundError({ machineId: input.machineId }));
    }
    return { machineId: input.machineId, desiredStateVersion: row.desiredStateVersion };
  });
