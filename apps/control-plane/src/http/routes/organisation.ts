import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { PackagePinConflictError } from "../../domain/machine/errors";
import { OrgPackagesError } from "../../domain/organisation/packages";
import { OrgSettingsError } from "../../domain/organisation/settings";
import { CurrentUserAuthentication } from "../middleware/auth";

// Real backend for the Organisation page. An aggregate
// read/write over settings that already live in, and are governed by,
// several other domains — see domain/organisation/settings.ts's header
// comment for why this doesn't duplicate their storage.
//
// Every endpoint here is `CurrentUserAuthentication`-gated, and neither
// `orgId` nor `actor` is on the wire any more. Both used to be, with no
// middleware on the group at all: `GET /api/v1/organisation` answered any
// caller who knew an org id, and `PATCH` let that same caller set
// `approvalModes` (break_glass to "none"), the logging tier and the
// retention window — then name whoever they liked as the `actor` on the
// resulting, permanent `organisation.updated` event. The org id is not a
// secret either; it is in the body of every response, this one included.
// The actor is now the authenticated caller, so the audit record says who
// actually made the change.

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
});

const UpdateOrgSettingsPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  approvalModes: Schema.optional(Schema.partial(ApprovalModes)),
  loggingTier: Schema.optional(LoggingTier),
  retentionDefaultDays: Schema.optional(Schema.Number),
  retentionLocation: Schema.optional(RetentionLocation),
});

// Org-scope package manifest entries. Sibling of `PATCH /api/v1/machines/:id/packages`
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

const ListOrgPackagesResponse = Schema.Struct({ items: Schema.Array(OrgPackageEntryResource) });

const UpdateOrgPackagesPayload = Schema.Struct({
  upserts: Schema.optional(Schema.Array(PackageManifestEntry)),
  removals: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
});

const UpdateOrgPackagesResponse = Schema.Struct({ items: Schema.Array(OrgPackageEntryResource) });

export const OrganisationGroup = HttpApiGroup.make("organisation")
  .add(
    HttpApiEndpoint.get("get", "/api/v1/organisation")
      .addSuccess(OrgSettingsResource)
      .addError(OrgSettingsError, { status: 404 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.patch("update", "/api/v1/organisation")
      .setPayload(UpdateOrgSettingsPayload)
      .addSuccess(OrgSettingsResource)
      .addError(OrgSettingsError, { status: 400 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.get("listPackages", "/api/v1/organisation/packages")
      .addSuccess(ListOrgPackagesResponse)
      .addError(OrgPackagesError, { status: 404 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.patch("updatePackages", "/api/v1/organisation/packages")
      .setPayload(UpdateOrgPackagesPayload)
      .addSuccess(UpdateOrgPackagesResponse)
      .addError(PackagePinConflictError, { status: 422 })
      .addError(OrgPackagesError, { status: 404 })
      .middleware(CurrentUserAuthentication),
  );
