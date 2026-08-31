import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { PackagePinConflictError } from "../../domain/machine/errors";
import { OrgPackagesError } from "../../domain/organisation/packages";
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
  // How many machines in this org have their own logging-tier override —
  // see `domain/organisation/settings.ts`'s `OrgSettingsView` doc comment.
  loggingTierOverrideCount: Schema.Number,
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

// Org-scope package manifest entries (spec.md §6, docs/inheritance.md
// "Package manifest"). Sibling of `PATCH /api/v1/machines/:id/packages`
// (`http/routes/machines.ts`) but for the `org`-scoped rows of the same
// `machine_packages` table — see `domain/organisation/packages.ts`.
const PackageManifestEntry = Schema.Struct({
  packageName: Schema.String.pipe(Schema.minLength(1)),
  versionPin: Schema.optional(Schema.NullOr(Schema.String)),
  pinned: Schema.optional(Schema.Boolean),
});

const OrgPackageEntryResource = Schema.Struct({
  packageName: Schema.String,
  versionPin: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
});

const ListOrgPackagesUrlParams = Schema.Struct({ orgId: Schema.String });

const ListOrgPackagesResponse = Schema.Struct({ items: Schema.Array(OrgPackageEntryResource) });

const UpdateOrgPackagesPayload = Schema.Struct({
  orgId: Schema.String,
  upserts: Schema.optional(Schema.Array(PackageManifestEntry)),
  removals: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
  actor: ConfigActor,
});

const UpdateOrgPackagesResponse = Schema.Struct({ items: Schema.Array(OrgPackageEntryResource) });

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
  )
  .add(
    HttpApiEndpoint.get("listPackages", "/api/v1/organisation/packages")
      .setUrlParams(ListOrgPackagesUrlParams)
      .addSuccess(ListOrgPackagesResponse)
      .addError(OrgPackagesError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.patch("updatePackages", "/api/v1/organisation/packages")
      .setPayload(UpdateOrgPackagesPayload)
      .addSuccess(UpdateOrgPackagesResponse)
      .addError(PackagePinConflictError, { status: 422 })
      .addError(OrgPackagesError, { status: 404 }),
  );
