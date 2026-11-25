import { machines } from "@cloudable/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { clearResolvedFindings, upsertFindingFirstSeen } from "../finding-store";

const ARCHIVED_STATES: Array<"archived_restorable" | "archived_expired"> = [
  "archived_restorable",
  "archived_expired",
];

const CHECK_ID = "no-unapproved-apt-sources";

/**
 * "No unapproved apt sources": every apt source on a machine is Ubuntu's own, or one of the
 * org's approved repositories. A source anything else put there is a way software reaches a
 * machine without a recorded decision (invariant 4).
 *
 * Reads `machines.undeclaredAptSources`, which the report path computes from what the
 * agent found (`recordReportedAptState`). A machine that has not reported its sources yet
 * produces no finding: an older agent, or no apt.
 *
 * `detailKey` is the machine id, one finding per machine, like "no undeclared software".
 */
export const noUnapprovedAptSourcesCheck: ComplianceCheck = {
  id: CHECK_ID,
  label: "No unapproved apt sources",
  severity: "medium",
  controlRefs: ["asset-management"],

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
      const live = yield* Effect.orDie(
        Effect.tryPromise(() =>
          db
            .select({ id: machines.id, undeclared: machines.undeclaredAptSources })
            .from(machines)
            .where(and(eq(machines.orgId, orgId), notInArray(machines.state, ARCHIVED_STATES))),
        ),
      );

      const findings: ComplianceFinding[] = [];
      const open: string[] = [];
      for (const machine of live) {
        const undeclared = Array.isArray(machine.undeclared) ? machine.undeclared : [];
        if (undeclared.length === 0) continue;
        open.push(machine.id);
        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: CHECK_ID,
          orgId,
          machineId: machine.id,
          detailKey: machine.id,
        }).pipe(Effect.orDie);
        findings.push({
          checkId: CHECK_ID,
          orgId,
          machineId: machine.id,
          firstSeenAt,
          detail: { undeclaredAptSources: undeclared },
        });
      }
      yield* clearResolvedFindings(CHECK_ID, orgId, open).pipe(Effect.orDie);
      return findings;
    }),
};
