import { machines } from "@cloudable/schema";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";

export interface MachineRecord {
  readonly id: string;
  readonly orgId: string;
  readonly state: string;
  readonly lastVerifiedAt: Date | null;
}

/**
 * Thin read/write wrapper around the `machines` table for the
 * agent-protocol handlers (`../../http/handlers/agent-protocol.ts`).
 * Exists so those handlers depend on a small domain service instead of the
 * raw `Db` tag directly — matching `EventBus`'s shape: `Db` is consumed
 * internally and never re-exposed, so `apps/control-plane/src/layers.ts`
 * only has to wire this `.Default` alongside `EventBus.Default`, rather
 * than threading `Db` itself through every consumer of `buildAppLive`'s
 * merged layer (which doesn't expose it — see this unit's PR description).
 *
 * Any lookup/update failure here is treated as an infra fault (`Effect.orDie`,
 * a defect rather than a typed error) — a database being unreachable isn't
 * a client-facing "this credential/session is invalid" outcome, so it
 * isn't declared on the `agent-protocol` `HttpApiEndpoint`s and instead
 * falls through to the framework's default error response.
 */
export class MachineDirectory extends Effect.Service<MachineDirectory>()("MachineDirectory", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const findById = (machineId: string): Effect.Effect<MachineRecord | undefined> =>
      Effect.tryPromise({
        try: () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
        catch: (cause) => new Error(`machine lookup failed: ${String(cause)}`),
      }).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      );

    // A successful check-in is the strongest liveness signal this control plane has —
    // direct proof the OS booted, cloud-init ran, and the agent is attesting. It
    // self-heals `state`, promoting `"provisioning"` (the normal case: nothing has
    // marked this machine "running" yet, see `reconcile/persist-result.ts`'s own
    // doc comment on why nothing did before this) and correcting a stale `"error"`
    // (a reconcile pass can land in the narrow window before Azure's hypervisor
    // reports the VM as powered on — see that same file's grace-period comment; this
    // is the backstop for the rare case that window still produced a false "error").
    // Keyed on the row's *current* `state`, not "is this the first check-in ever" —
    // so any later successful check-in can still correct an earlier mistake, not
    // just the first one. Deliberately excludes every archived/stopped state: a
    // check-in must never revive an archived row's displayed state. One statement,
    // not a read-then-write — same conditional-`CASE` idiom
    // `CloudCatalogService.ts`'s `upsertEntries` and `persist-result.ts` already use,
    // so there's no race between checking the current state and acting on it.
    const markVerified = (machineId: string, at: Date): Effect.Effect<void> =>
      Effect.tryPromise({
        try: () =>
          db
            .update(machines)
            .set({
              lastVerifiedAt: at,
              state: sql`CASE WHEN ${machines.state} IN ('provisioning', 'error') THEN 'running' ELSE ${machines.state} END`,
              lastError: sql`CASE WHEN ${machines.state} IN ('provisioning', 'error') THEN NULL ELSE ${machines.lastError} END`,
            })
            .where(eq(machines.id, machineId)),
        catch: (cause) => new Error(`machine update failed: ${String(cause)}`),
      }).pipe(Effect.asVoid, Effect.orDie);

    return { findById, markVerified } as const;
  }),
}) {}
