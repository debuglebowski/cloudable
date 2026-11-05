import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { requireAdminUser } from "../../domain/authz";
import { requestApprovalSettingsChange } from "../../domain/organisation/approval-settings-change";
import {
  type OrgPackagesError,
  listOrgPackages,
  updateOrgPackages,
} from "../../domain/organisation/packages";
import {
  OrgSettingsError,
  getOrgSettings,
  updateOrgSettings,
} from "../../domain/organisation/settings";
import { EVENTS_RETENTION_INVALID_REASON } from "../../domain/retention/policy";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";
import { toApprovalWire } from "../routes/approvals";

/** Which `OrgSettingsError` reasons are genuine client-facing validation
 * failures (worth a typed 4xx) versus our own infrastructure breaking
 * (an infra failure isn't a meaningful outcome for a caller — `Effect.die`
 * it, same convention every other domain in this codebase uses). */
const VALIDATION_REASONS = new Set([
  "org_not_found",
  "approval_modes_need_sign_off",
  "no_approval_mode_change",
  "reason_required",
  "org_name_required",
  "retention_days_must_be_a_positive_integer",
  EVENTS_RETENTION_INVALID_REASON,
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
        yield* requireAdminUser(currentUser, "Only an admin can change organisation settings.");
        // Approval modes change only with an approver's sign-off (`requestApprovalModesChange`).
        // Sending today's values back unchanged is allowed, so a form that posts everything
        // still saves its other fields.
        if (payload.approvalModes !== undefined) {
          const current = yield* getOrgSettings(currentUser.orgId);
          const changes = Object.entries(payload.approvalModes).some(
            ([actionType, mode]) =>
              mode !== undefined &&
              current.approvalModes[actionType as keyof typeof current.approvalModes] !== mode,
          );
          if (changes) {
            return yield* Effect.fail(
              new OrgSettingsError({ reason: "approval_modes_need_sign_off" }),
            );
          }
        }
        return yield* updateOrgSettings({
          orgId: currentUser.orgId,
          name: payload.name,
          loggingTier: payload.loggingTier,
          retentionDefaultDays: payload.retentionDefaultDays,
          eventRetentionDays: payload.eventRetentionDays,
          retentionLocation: payload.retentionLocation,
          // The authenticated caller, never a name they chose for themselves. This is the
          // actor on a permanent `organisation.updated` event.
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }).pipe(Effect.catchTag("OrgSettingsError", rethrowInfraAsDefect)),
    )
    .handle("requestApprovalModesChange", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can ask to change approval settings.");
        const approval = yield* requestApprovalSettingsChange({
          orgId: currentUser.orgId,
          personId: currentUser.personId,
          approvalModes: payload.approvalModes,
          reason: payload.reason,
        });
        return toApprovalWire(approval);
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
        // The org manifest says which packages any machine may have: configuration, so admin.
        yield* requireAdminUser(currentUser, "Only an admin can change the org's packages.");
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
