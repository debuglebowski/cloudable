import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  getOrgSettings,
  type OrgSettingsError,
  updateOrgSettings,
} from "../../domain/organisation/settings";
import { Api } from "../api";

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

export const OrganisationLive = HttpApiBuilder.group(Api, "organisation", (handlers) =>
  handlers
    .handle("get", ({ urlParams }) =>
      getOrgSettings(urlParams.orgId).pipe(
        Effect.catchTag("OrgSettingsError", rethrowInfraAsDefect),
      ),
    )
    .handle("update", ({ payload }) =>
      updateOrgSettings({
        orgId: payload.orgId,
        name: payload.name,
        approvalModes: payload.approvalModes,
        loggingTier: payload.loggingTier,
        retentionDefaultDays: payload.retentionDefaultDays,
        retentionLocation: payload.retentionLocation,
        actor: { actorType: payload.actor.type, actorId: payload.actor.id },
      }).pipe(Effect.catchTag("OrgSettingsError", rethrowInfraAsDefect)),
    ),
);
