import { machines } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Context } from "effect";
import type { Db } from "../../db/layer";

/**
 * Stores the baseline label a machine's agent reported from its own stamp file.
 *
 * Written on every report, null included: the label is whatever the machine says right
 * now, so a stamp that has gone reads as "none" instead of lingering as the last thing
 * the machine claimed. A failure is logged and swallowed, because the rest of what the
 * agent reported still has to be stored.
 */
export const recordHardeningBaseline = (
  db: Context.Tag.Service<typeof Db>,
  machineId: string,
  baseline: string | undefined,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () =>
      db
        .update(machines)
        .set({ hardeningBaseline: baseline ?? null })
        .where(eq(machines.id, machineId)),
    catch: (cause) => new Error(`hardening baseline update failed: ${String(cause)}`),
  }).pipe(
    Effect.asVoid,
    Effect.catchAll((error) =>
      Effect.logWarning(`report: failed to store hardening baseline: ${error.message}`),
    ),
  );
