import { HttpApiBuilder } from "@effect/platform";
import { Effect, Layer } from "effect";
import { computeControlMap } from "../../compliance/control-map";
import { evaluateAllChecks } from "../../compliance/evaluate-all";
import {
  assetInventoryCsv,
  collectOpenFindingsByControl,
  findingsByControlCsv,
  openFindingsCsv,
} from "../../compliance/evidence-export";
import { ageInDays } from "../../compliance/finding-store";
import { DbLive } from "../../db/layer";
import { Api } from "../api";

const ComplianceGroupLive = HttpApiBuilder.group(Api, "compliance", (handlers) =>
  handlers
    .handle("controlMap", () => Effect.succeed({ controls: computeControlMap() }))
    .handle("findings", ({ urlParams }) =>
      Effect.gen(function* () {
        const now = new Date();
        const evaluations = yield* evaluateAllChecks(urlParams.orgId);
        return {
          orgId: urlParams.orgId,
          generatedAt: now.toISOString(),
          checks: evaluations.map((evaluation) => ({
            checkId: evaluation.check.id,
            label: evaluation.check.label,
            controlRefs: [...evaluation.check.controlRefs],
            status: evaluation.status,
            findings: evaluation.findings.map((finding) => ({
              machineId: finding.machineId,
              firstSeenAt: finding.firstSeenAt.toISOString(),
              ageDays: ageInDays(finding.firstSeenAt, now),
              detail: finding.detail,
            })),
          })),
        };
      }),
    )
    .handle("findingsExport", ({ urlParams }) =>
      collectOpenFindingsByControl(urlParams.orgId).pipe(Effect.map(findingsByControlCsv)),
    )
    .handle("assetInventoryCsv", ({ urlParams }) => assetInventoryCsv(urlParams.orgId))
    .handle("findingsCsv", ({ urlParams }) =>
      collectOpenFindingsByControl(urlParams.orgId).pipe(Effect.map(openFindingsCsv)),
    ),
);

/**
 * Self-contained: provides its own `Db` rather than relying on the
 * caller's layer graph, since `buildAppLive` (see `../../layers.ts`)
 * consumes `Db` internally for its services without re-exporting it.
 * `Db`/`DbLive` are referenced by the same import elsewhere in the graph
 * (e.g. `buildAppLive`), so Effect's layer memoization shares the one
 * underlying Postgres connection rather than opening a second.
 */
export const ComplianceLive = ComplianceGroupLive.pipe(Layer.provide(DbLive));
