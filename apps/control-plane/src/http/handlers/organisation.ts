import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  type OrgPackagesError,
  listOrgPackages,
  updateOrgPackages,
} from "../../domain/organisation/packages";
import {
  type OrgSettingsError,
  getOrgSettings,
  updateOrgSettings,
} from "../../domain/organisation/settings";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

/** Which `OrgSettingsError` reasons are genuine client-facing validation
 * failures (worth a typed 4xx) versus our own infrastructure breaking
 * (an infra failure isn't a meaningful outcome for a caller — `Effect.die`
 * it, same convention every other domain in this codebase uses). */
const VALIDATION_REASONS = new Set([
  "org_not_found",
  "org_name_required",
  "retention_days_must_be_a_positive_integer",
]);

const rethrowInfraAsDefect = (e: OrgSettingsError) =>
  VALIDATION_REASONS.has(e.reason) ? Effect.fail(e) : Effect.die(e);

/** `org_not_found` is the one client-facing validation reason for
 * `OrgPackagesError` (same convention as `VALIDATION_REASONS` above); every
 * other reason is our own infra breaking (`Effect.die` it). `PackagePinConflictError`
 * is a separate tagged error and passes through untouched to the `.addError()`
 * on the endpoint. */
const rethrowPackagesInfraAsDefect = (e: OrgPackagesError) =>
  e.reason === "org_not_found" ? Effect.fail(e) : Effect.die(e);

export const OrganisationLive = HttpApiBuilder.group(Api, "organisation", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.flatMap(CurrentUserTag, (currentUser) => getOrgSettings(currentUser.orgId)).pipe(
        Effect.catchTag("OrgSettingsError", rethrowInfraAsDefect),
      ),
    )
    .handle("update", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* updateOrgSettings({
          orgId: currentUser.orgId,
          name: payload.name,
          approvalModes: payload.approvalModes,
          loggingTier: payload.loggingTier,
          retentionDefaultDays: payload.retentionDefaultDays,
          retentionLocation: payload.retentionLocation,
          // The authenticated caller, never a name they chose for themselves. This is the
          // actor on a permanent `organisation.updated` event.
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }).pipe(Effect.catchTag("OrgSettingsError", rethrowInfraAsDefect)),
    )
    .handle("listPackages", () =>
      Effect.flatMap(CurrentUserTag, (currentUser) => listOrgPackages(currentUser.orgId)).pipe(
        Effect.map((items) => ({ items })),
        Effect.catchTag("OrgPackagesError", rethrowPackagesInfraAsDefect),
      ),
    )
    .handle("updatePackages", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* updateOrgPackages({
          orgId: currentUser.orgId,
          upserts: payload.upserts,
          removals: payload.removals,
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }).pipe(
        Effect.map((items) => ({ items })),
        Effect.catchTag("OrgPackagesError", rethrowPackagesInfraAsDefect),
      ),
    ),
);
