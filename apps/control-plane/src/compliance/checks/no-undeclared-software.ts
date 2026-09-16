import { machinePackages, machines } from "@cloudable/schema";
import { and, eq, notInArray, or } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { type MachinePackageRow, resolveManifest } from "../../domain/machine/manifest";
import { buildPackagesView, undeclaredFromView } from "../../domain/machine/packages-view";
import { clearResolvedFindings, upsertFindingFirstSeen } from "../finding-store";

// Same set as active-owner.ts's ARCHIVED_STATES (not shared: two small
// literal arrays are cheaper to keep in sync than a cross-check-file
// import for something this stable).
const ARCHIVED_STATES: Array<"archived_restorable" | "archived_expired"> = [
  "archived_restorable",
  "archived_expired",
];

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;

/**
 * Check #3 — "No undeclared software".
 *
 * Computed from what the agent actually reports, which is new. It used to read
 * `machine.drift_detected` events, and those had one live emitter: a
 * reconcile loop that compared the manifest against a provider call which
 * never returned real package data. On Azure it returned none at all, so the
 * check passed everywhere by construction. `machine.drift_resolved` was never
 * emitted by anything, so a finding it did open could never close.
 *
 * Now: reported inventory, minus the image baseline, minus anything allowed.
 * The same set the machine's packages table shows with its toggle off, via the
 * same `buildPackagesView` — one definition of "undeclared", not two that can
 * drift apart.
 *
 * Subtracting the baseline is what makes this usable rather than noise. A real
 * Ubuntu server image is several hundred packages; without that subtraction
 * every machine reports several hundred findings on its first check-in and the
 * check means nothing.
 *
 * A machine that has never reported produces no finding. It has told us
 * nothing, and "no evidence of undeclared software" is not the same claim as
 * "we looked and there is none" — the "machines are reporting" check is what
 * catches a machine that has gone quiet.
 *
 * `detailKey` is the machine id — one finding per machine, matching check #2.
 */
export const noUndeclaredSoftwareCheck: ComplianceCheck = {
  id: "no-undeclared-software",
  label: "No undeclared software",
  // Drift from the declared manifest matters, but is a divergence to
  // investigate, not by itself proof of active harm — medium.
  severity: "medium",
  controlRefs: ["asset-management"],

  // Not applicable to an org with no live machines — nothing to have
  // undeclared software on.
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

      const liveMachines = yield* Effect.orDie(
        Effect.tryPromise(() =>
          db
            .select()
            .from(machines)
            .where(and(eq(machines.orgId, orgId), notInArray(machines.state, ARCHIVED_STATES))),
        ),
      );

      const findings: ComplianceFinding[] = [];
      const openMachineIds: string[] = [];

      for (const machine of liveMachines) {
        const installedPackages = stringArray(machine.installedPackages);
        // Never reported. Nothing to say about software on a machine that has
        // not spoken to us — that silence is check #4's business, not this one's.
        if (installedPackages === null) continue;

        const manifestRows = yield* Effect.orDie(
          Effect.tryPromise(() =>
            db
              .select()
              .from(machinePackages)
              .where(
                or(
                  and(
                    eq(machinePackages.scopeType, "org"),
                    eq(machinePackages.scopeId, machine.orgId),
                  ),
                  and(
                    eq(machinePackages.scopeType, "machine"),
                    eq(machinePackages.scopeId, machine.id),
                  ),
                ),
              ),
          ),
        );

        const manifest = resolveManifest(manifestRows as MachinePackageRow[], {
          orgId: machine.orgId,
          templateId: machine.templateId,
          machineId: machine.id,
        });

        const undeclaredPackages = undeclaredFromView(
          buildPackagesView({
            manifest,
            installedPackages,
            baselinePackages: stringArray(machine.baselinePackages),
          }),
        );

        if (undeclaredPackages.length === 0) continue;

        openMachineIds.push(machine.id);
        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: "no-undeclared-software",
          orgId,
          machineId: machine.id,
          detailKey: machine.id,
        }).pipe(Effect.orDie);

        findings.push({
          checkId: "no-undeclared-software",
          orgId,
          machineId: machine.id,
          firstSeenAt,
          detail: { undeclaredPackages },
        });
      }

      // Anything previously open that is not open now has resolved — the
      // package was removed, allowed, or the machine was archived. Unlike the
      // event-based version, this can actually close: it re-derives the answer
      // from current state every run rather than waiting for a resolution
      // event that nothing ever emitted.
      yield* clearResolvedFindings("no-undeclared-software", orgId, openMachineIds).pipe(
        Effect.orDie,
      );

      return findings;
    }),
};
