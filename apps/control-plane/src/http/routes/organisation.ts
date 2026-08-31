import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { OrgSettingsError } from "../../domain/organisation/settings";

// Real backend for the Organisation page (spec §20). An aggregate
// read/write over settings that already live in, and are governed by,
// several other domains — see domain/organisation/settings.ts's header
// comment for why this doesn't duplicate their storage.

const ApprovalActionType = Schema.Literal(
  "snapshot_restore",
  "break_glass",
  "admin_access",
  "offboarding",
);
const ApprovalMode = Schema.Literal("none", "single", "dual");
const LoggingTier = Schema.Literal(1, 2, 3);
const RetentionLocation = Schema.Literal("customer", "cloudable_sweden_central");

const ApprovalModes = Schema.Record({ key: ApprovalActionType, value: ApprovalMode });

const OrgSettingsResource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  approvalModes: ApprovalModes,
  loggingTier: LoggingTier,
  retentionDefaultDays: Schema.Number,
  retentionLocation: RetentionLocation,
  regionDefault: Schema.String,
});

const GetOrgSettingsUrlParams = Schema.Struct({ orgId: Schema.String });

const ConfigActor = Schema.Struct({
  type: Schema.Literal("person", "system"),
  id: Schema.String,
});

const UpdateOrgSettingsPayload = Schema.Struct({
  orgId: Schema.String,
  name: Schema.optional(Schema.String),
  approvalModes: Schema.optional(Schema.partial(ApprovalModes)),
  loggingTier: Schema.optional(LoggingTier),
  retentionDefaultDays: Schema.optional(Schema.Number),
  retentionLocation: Schema.optional(RetentionLocation),
  regionDefault: Schema.optional(Schema.String),
  actor: ConfigActor,
});

export const OrganisationGroup = HttpApiGroup.make("organisation")
  .add(
    HttpApiEndpoint.get("get", "/api/v1/organisation")
      .setUrlParams(GetOrgSettingsUrlParams)
      .addSuccess(OrgSettingsResource)
      .addError(OrgSettingsError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/api/v1/organisation")
      .setPayload(UpdateOrgSettingsPayload)
      .addSuccess(OrgSettingsResource)
      .addError(OrgSettingsError, { status: 400 }),
  );
