import { machines, people } from "@cloudable/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { clearResolvedFindings, upsertFindingFirstSeen } from "../finding-store";

/** Live states — everything except the two archived states. */
const ARCHIVED_STATES: Array<"archived_restorable" | "archived_expired"> = [
  "archived_restorable",
  "archived_expired",
];

/**
 * Check #2 — "Machine has an active owner" (docs/spec.md §19).
 *
 * Fails when a live machine has no owner, or its owner has been
 * deactivated (invariant 3: a machine always has exactly one owner,
 * always a person).
 *
 * `appliesTo`'s type (`Effect.Effect<boolean>`, no `Db` requirement — see
 * `domain/compliance/types.ts`) means it cannot itself look up a specific
 * machine's archived state. So "ownership questions don't apply to an
 * archived machine" is enforced inside `evaluate`'s query instead, via the
 * `notInArray(machines.state, ARCHIVED_STATES)` filter: an archived
 * machine never reaches the loop that produces findings, which is
 * behaviorally equivalent to gating it out via `appliesTo`.
 */
export const activeOwnerCheck: ComplianceCheck = {
  id: "active-owner",
  label: "Machine has an active owner",
  controlRefs: ["access-management"],

  appliesTo: () => Effect.succeed(true),

  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;

      const rows = yield* Effect.orDie(
        Effect.tryPromise(() =>
          db
            .select({
              machineId: machines.id,
              ownerPersonId: machines.ownerPersonId,
              ownerActive: people.active,
            })
            .from(machines)
            .leftJoin(people, eq(machines.ownerPersonId, people.id))
            .where(and(eq(machines.orgId, orgId), notInArray(machines.state, ARCHIVED_STATES))),
        ),
      );

      const findings: ComplianceFinding[] = [];
      const openMachineIds: string[] = [];
      for (const row of rows) {
        const reason =
          row.ownerPersonId === null
            ? ("no_owner" as const)
            : row.ownerActive === false
              ? ("owner_deactivated" as const)
              : null;
        if (reason === null) continue;

        openMachineIds.push(row.machineId);

        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: "active-owner",
          orgId,
          machineId: row.machineId,
          detailKey: row.machineId,
        }).pipe(Effect.orDie);

        findings.push({
          checkId: "active-owner",
          orgId,
          machineId: row.machineId,
          firstSeenAt,
          detail: { ownerPersonId: row.ownerPersonId, reason },
        });
      }

      // Anything previously open for this check+org that isn't among the
      // machines found just now has resolved (owner assigned/reactivated,
      // or the machine was archived) — stop aging it, so a later reopen of
      // the same machine id is treated as newly opened.
      yield* clearResolvedFindings("active-owner", orgId, openMachineIds).pipe(Effect.orDie);

      return findings;
    }),
};
