import { HttpApiBuilder } from "@effect/platform";
import { Effect, Layer } from "effect";
import { applyControlOverrides, computeControlMap } from "../../compliance/control-map";
import {
  type ControlOverrideStoreError,
  clearControlOverride,
  loadControlOverrides,
  setControlOverride,
} from "../../compliance/control-overrides-store";
import { evaluateAllChecks } from "../../compliance/evaluate-all";
import {
  assetInventoryCsv,
  collectOpenFindingsByControl,
  findingsByControlCsv,
  openFindingsCsv,
  vulnerabilitiesCsv,
} from "../../compliance/evidence-export";
import { ageInDays, medianAgeInDays } from "../../compliance/finding-store";
import { DbLive } from "../../db/layer";
import { requireAdminUser } from "../../domain/authz";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

/** DB/infra failure loading or writing overrides is never a meaningful outcome for an
 * HTTP caller — same convention as `OrgSettingsError`'s infra branch in
 * `http/handlers/organisation.ts`. `UnknownControlError` is deliberately NOT passed to
 * this — it's the one client-facing outcome, declared via `.addError()` on the route. */
const rethrowStoreErrorAsDefect = (e: ControlOverrideStoreError) => Effect.die(e);

const ComplianceGroupLive = HttpApiBuilder.group(Api, "compliance", (handlers) =>
  handlers
    .handle("controlMap", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, COMPLIANCE_ADMIN_ONLY);
        const overrides = yield* loadControlOverrides(currentUser.orgId);
        return { controls: applyControlOverrides(computeControlMap(), overrides) };
      }).pipe(Effect.catchTag("ControlOverrideStoreError", rethrowStoreErrorAsDefect)),
    )
    .handle("setControlOverride", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can override a control.");
        // Loaded BEFORE the write, then merged with the just-applied change in memory
        // below, rather than re-querying after — a transient failure on a second read
        // would otherwise report this write as failed even though it had already
        // committed, leaving the console's dialog open and the user unsure whether
        // their change stuck (it did).
        const overridesBeforeWrite = yield* loadControlOverrides(currentUser.orgId);
        if (payload.status === null) {
          yield* clearControlOverride(currentUser.orgId, path.controlId);
        } else {
          yield* setControlOverride(currentUser.orgId, path.controlId, payload.status);
        }
        const otherOverrides = overridesBeforeWrite.filter((o) => o.controlId !== path.controlId);
        const overrides =
          payload.status === null
            ? otherOverrides
            : [...otherOverrides, { controlId: path.controlId, status: payload.status }];
        return { controls: applyControlOverrides(computeControlMap(), overrides) };
      }).pipe(Effect.catchTag("ControlOverrideStoreError", rethrowStoreErrorAsDefect)),
    )
    .handle("findings", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, COMPLIANCE_ADMIN_ONLY);
        const now = new Date();
        const evaluations = yield* evaluateAllChecks(currentUser.orgId);
        return {
          orgId: currentUser.orgId,
          generatedAt: now.toISOString(),
          checks: evaluations.map((evaluation) => {
            // Collected alongside the findings map below (rather than a
            // second `.map` over `evaluation.findings`) purely to avoid a
            // redundant traversal — findings sets here are small, but one
            // pass is as easy as two.
            const firstSeenAts: Date[] = [];
            const findings = evaluation.findings.map((finding) => {
              firstSeenAts.push(finding.firstSeenAt);
              return {
                machineId: finding.machineId,
                firstSeenAt: finding.firstSeenAt.toISOString(),
                ageDays: ageInDays(finding.firstSeenAt, now),
                detail: finding.detail,
              };
            });

            return {
              checkId: evaluation.check.id,
              label: evaluation.check.label,
              controlRefs: [...evaluation.check.controlRefs],
              status: evaluation.status,
              severity: evaluation.check.severity,
              findings,
              medianAgeDays: medianAgeInDays(firstSeenAts, now),
            };
          }),
        };
      }),
    )
    .handle("findingsExport", () =>
      Effect.flatMap(adminCaller, (currentUser) =>
        collectOpenFindingsByControl(currentUser.orgId),
      ).pipe(Effect.map(findingsByControlCsv)),
    )
    .handle("assetInventoryCsv", () =>
      Effect.flatMap(adminCaller, (currentUser) => assetInventoryCsv(currentUser.orgId)),
    )
    .handle("findingsCsv", () =>
      Effect.flatMap(adminCaller, (currentUser) =>
        collectOpenFindingsByControl(currentUser.orgId),
      ).pipe(Effect.map(openFindingsCsv)),
    )
    .handle("vulnerabilitiesCsv", () =>
      Effect.flatMap(adminCaller, (currentUser) => vulnerabilitiesCsv(currentUser.orgId)),
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
const COMPLIANCE_ADMIN_ONLY = "Only an admin can see compliance evidence.";

/** The caller, once they are known to be an admin. Compliance evidence covers the whole org. */
const adminCaller = Effect.tap(CurrentUserTag, (currentUser) =>
  requireAdminUser(currentUser, COMPLIANCE_ADMIN_ONLY),
);

export const ComplianceLive = ComplianceGroupLive.pipe(Layer.provide(DbLive));
