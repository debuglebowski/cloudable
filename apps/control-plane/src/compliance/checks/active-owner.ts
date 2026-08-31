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
 * A specific machine's archived state is still filtered inside `evaluate`'s
 * query (`notInArray(machines.state, ARCHIVED_STATES)`) rather than
 * `appliesTo` — `appliesTo` gates at the *org* level ("does this org have
 * any live machine at all to have an owner question about"), not per
 * machine; `evaluate` still excludes individual archived machines from an
 * org that also has live ones.
 */
export const activeOwnerCheck: ComplianceCheck = {
  id: "active-owner",
  label: "Machine has an active owner",
  // An unowned or deactivated-owner machine is an accountability gap, not
  // an active exposure by itself — medium, not high.
  severity: "medium",
  controlRefs: ["access-management"],

  // Not applicable to an org with no live machines — nothing to have an
  // ownership question about.
  appliesTo: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const rows = yield* Effect.tryPromise(() =>
        db
          .select({ id: machines.id })
          .from(machines)
          .where(and(eq(machines.orgId, orgId), notInArray(machines.state, ARCHIVED_STATES)))
          .limit(1),
      ).pipe(Effect.orDie);
      return rows.length > 0;
    }),

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
