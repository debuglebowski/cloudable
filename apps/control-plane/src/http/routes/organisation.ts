import { isValidDeclaredPackageName } from "@cloudable/contracts";
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { PackagePinConflictError } from "../../domain/machine/errors";
import { OrgPackagesError } from "../../domain/organisation/packages";
import { OrgSettingsError } from "../../domain/organisation/settings";
import { CurrentUserAuthentication } from "../middleware/auth";
import { ApprovalResource } from "./approvals";

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
  "package_install",
);
const ApprovalMode = Schema.Literal("none", "single", "dual");
const LoggingTier = Schema.Literal(1, 2);
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
  eventRetentionDays: Schema.Number,
  retentionLocation: RetentionLocation,
});

const RequestApprovalModesChangePayload = Schema.Struct({
  approvalModes: Schema.partial(ApprovalModes),
  reason: Schema.String.pipe(Schema.minLength(1)),
});

const UpdateOrgSettingsPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  // Refused unless every mode sent equals today's: approval modes change only through
  // `requestApprovalModesChange` below. Kept on the wire so an old console gets a clear error.
  approvalModes: Schema.optional(Schema.partial(ApprovalModes)),
  loggingTier: Schema.optional(LoggingTier),
  retentionDefaultDays: Schema.optional(Schema.Number),
  eventRetentionDays: Schema.optional(Schema.Number),
  retentionLocation: Schema.optional(RetentionLocation),
});

// Org-scope package manifest entries. Sibling of `PATCH /api/v1/machines/:id/packages`
// (`http/routes/machines.ts`) but for the `org`-scoped rows of the same
// `machine_packages` table — see `domain/organisation/packages.ts`.
// An apt name, or `<manager>:<name>`. See `PACKAGE_MANAGERS` in the contracts package.
const DeclaredPackageName = Schema.String.pipe(
  Schema.filter(isValidDeclaredPackageName, {
    message: () => "not a valid package name: use an apt name or <npm|pipx|cargo|home>:<name>",
  }),
);

const PackageManifestEntry = Schema.Struct({
  packageName: DeclaredPackageName,
  versionPin: Schema.optional(Schema.NullOr(Schema.String)),
  pinned: Schema.optional(Schema.Boolean),
  // The declared parent this package is part of. Null clears it.
  partOf: Schema.optional(Schema.NullOr(DeclaredPackageName)),
  // Why it is allowed. Free text for people; nothing acts on it.
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(500)))),
}).pipe(
  Schema.filter((entry) => entry.partOf !== entry.packageName, {
    message: () => "a package cannot be part of itself",
  }),
);

const OrgPackageEntryResource = Schema.Struct({
  packageName: Schema.String,
  versionPin: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  partOf: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
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
    // An admin asks for new approval modes; an approver signs off; then they apply. Returns the
    // pending approval. See `domain/organisation/approval-settings-change.ts`.
    HttpApiEndpoint.post("requestApprovalModesChange", "/api/v1/organisation/approval-modes")
      .setPayload(RequestApprovalModesChangePayload)
      .addSuccess(ApprovalResource, { status: 202 })
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
