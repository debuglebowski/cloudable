import { events, machines } from "@cloudable/schema";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { upsertFindingFirstSeen } from "../finding-store";

const DRIFT_EVENT_TYPES = ["machine.drift_detected", "machine.drift_resolved"] as const;

// Same set as active-owner.ts's ARCHIVED_STATES (not shared: two small
// literal arrays are cheaper to keep in sync than a cross-check-file
// import for something this stable).
const ARCHIVED_STATES: Array<"archived_restorable" | "archived_expired"> = [
  "archived_restorable",
  "archived_expired",
];

function extractUndeclaredPackages(payload: unknown): string[] {
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { undeclaredPackages?: unknown }).undeclaredPackages)
  ) {
    return (payload as { undeclaredPackages: unknown[] }).undeclaredPackages.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return [];
}

/**
 * Check #3 — "No undeclared software" (docs/spec.md §19).
 *
 * Fails when installed packages diverge from the resolved manifest.
 * Rather than diffing `undeclaredPackages` sets across events, this uses
 * the "simplest" approach the unit brief explicitly allows: a machine is
 * currently drifted if the *latest* drift-related event recorded for it is
 * `machine.drift_detected` rather than `machine.drift_resolved`. Reconcile
 * only closes gaps (invariant 4) and drift is never auto-corrected
 * (invariant 5), so an open `drift_detected` genuinely stays open until an
 * explicit `drift_resolved` is recorded for that machine.
 *
 * `detailKey` for `upsertFindingFirstSeen` is the machine id — one finding
 * per machine, matching check #2 — not the triggering
 * `machine.drift_detected` event id. A machine that drifts, resolves, and
 * drifts again (even on a different package set) is treated as the same
 * finding key rather than a fresh incident. Per-incident granularity
 * (keying by the drift-detected event's id instead) is a reasonable
 * alternative if per-incident finding age is ever wanted; this unit picked
 * machine-level for consistency with check #2 and because the dashboard
 * story (docs/spec.md §19 "Finding age") is per open finding, not per
 * historical incident.
 *
 * Like check #2, this excludes archived machines from producing findings —
 * a machine that drifted and was later archived (with no `drift_resolved`
 * ever recorded, since offboarding doesn't remediate drift) shouldn't
 * surface as an open finding forever. As in `active-owner.ts`, `appliesTo`'s
 * type (`Effect.Effect<boolean>`, no `Db` requirement) can't itself look up
 * a machine's archived state, so the exclusion lives in `evaluate`'s query.
 */
export const noUndeclaredSoftwareCheck: ComplianceCheck = {
  id: "no-undeclared-software",
  label: "No undeclared software",
  // Drift from the declared manifest matters, but is a divergence to
  // investigate, not by itself proof of active harm — medium.
  severity: "medium",
  controlRefs: ["asset-management"],

  appliesTo: () => Effect.succeed(true),

  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;

      const liveMachineRows = yield* Effect.orDie(
        Effect.tryPromise(() =>
          db
            .select({ id: machines.id })
            .from(machines)
            .where(and(eq(machines.orgId, orgId), notInArray(machines.state, ARCHIVED_STATES))),
        ),
      );
      const liveMachineIds = new Set(liveMachineRows.map((row) => row.id));

      const rows = yield* Effect.orDie(
        Effect.tryPromise(() =>
          db
            .select({
              machineId: events.machineId,
              type: events.type,
              occurredAt: events.occurredAt,
              payload: events.payload,
            })
            .from(events)
            .where(and(eq(events.orgId, orgId), inArray(events.type, DRIFT_EVENT_TYPES)))
            .orderBy(asc(events.occurredAt)),
        ),
      );

      // Walk in occurredAt order, keeping only the latest drift-related
      // event per machine (last write in iteration order wins).
      const latestByMachine = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (row.machineId === null) continue;
        latestByMachine.set(row.machineId, row);
      }

      const findings: ComplianceFinding[] = [];
      for (const [machineId, latest] of latestByMachine) {
        if (latest.type !== "machine.drift_detected") continue;
        if (!liveMachineIds.has(machineId)) continue;

        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: "no-undeclared-software",
          orgId,
          machineId,
          detailKey: machineId,
        }).pipe(Effect.orDie);

        findings.push({
          checkId: "no-undeclared-software",
          orgId,
          machineId,
          firstSeenAt,
          detail: { undeclaredPackages: extractUndeclaredPackages(latest.payload) },
        });
      }
      return findings;
    }),
};
