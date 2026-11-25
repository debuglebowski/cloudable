import { isValidDeclaredPackageName } from "@cloudable/contracts";
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { PackageEnsureSettingError, PackageLockConflictError } from "../../domain/machine/errors";
import { AptRepositoryError } from "../../domain/organisation/apt-repositories";
import { OrgPackagesError } from "../../domain/organisation/packages";
import { OrgSettingsError } from "../../domain/organisation/settings";
import { CurrentUserAuthentication } from "../middleware/auth";
import { ApprovalResource } from "./approvals";
import { ensureApprovalSchema, packageSettingSchema } from "./machines";

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
  "package_ensure",
  "apt_repository",
  "machine_resize",
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
  ensureRetryHours: Schema.Number,
  // The nixpkgs commit `nix:` packages install from. Null until an admin sets one.
  nixSnapshot: Schema.NullOr(Schema.String),
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
  // Hours before a failed Ensure install is tried again, 1 to 720.
  ensureRetryHours: Schema.optional(Schema.Number),
  // A full 40-character nixpkgs commit, or null to clear it.
  nixSnapshot: Schema.optional(Schema.NullOr(Schema.String)),
  retentionLocation: Schema.optional(RetentionLocation),
});

// Org-scope package manifest entries. Sibling of `PATCH /api/v1/machines/:id/packages`
// (`http/routes/machines.ts`) but for the `org`-scoped rows of the same
// `machine_packages` table — see `domain/organisation/packages.ts`.
// An apt name, or `<manager>:<name>`. See `PACKAGE_MANAGERS` in the contracts package.
const DeclaredPackageName = Schema.String.pipe(
  Schema.filter(isValidDeclaredPackageName, {
    message: () => "not a valid package name: use an apt name or <npm|pipx|cargo|nix|home>:<name>",
  }),
);

const PackageManifestEntry = Schema.Struct({
  packageName: DeclaredPackageName,
  versionPin: Schema.optional(Schema.NullOr(Schema.String)),
  locked: Schema.optional(Schema.Boolean),
  // The declared parent this package is part of. Null clears it.
  partOf: Schema.optional(Schema.NullOr(DeclaredPackageName)),
  // Why it is allowed. Free text for people; nothing acts on it.
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(500)))),
  // Moving to an ensure setting waits for a `package_ensure` approval.
  setting: Schema.optional(packageSettingSchema),
}).pipe(
  Schema.filter((entry) => entry.partOf !== entry.packageName, {
    message: () => "a package cannot be part of itself",
  }),
);

export const OrgPackageEntryResource = Schema.Struct({
  packageName: Schema.String,
  versionPin: Schema.NullOr(Schema.String),
  locked: Schema.Boolean,
  partOf: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  setting: packageSettingSchema,
});

const ListOrgPackagesResponse = Schema.Struct({ items: Schema.Array(OrgPackageEntryResource) });

export const UpdateOrgPackagesPayload = Schema.Struct({
  upserts: Schema.optional(Schema.Array(PackageManifestEntry)),
  removals: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
});

export const UpdateOrgPackagesResponse = Schema.Struct({
  items: Schema.Array(OrgPackageEntryResource),
  // One per edit that set an ensure setting; those wait for their approval.
  ensureApprovals: Schema.optional(Schema.Array(ensureApprovalSchema)),
});

const AptRepositoryResource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  suite: Schema.String,
  components: Schema.Array(Schema.String),
  fingerprint: Schema.String,
  addedAt: Schema.String,
  removedAt: Schema.NullOr(Schema.String),
});

const AddAptRepositoryPayload = Schema.Struct({
  name: Schema.String.pipe(Schema.maxLength(100)),
  url: Schema.String.pipe(Schema.maxLength(2048)),
  suite: Schema.String.pipe(Schema.maxLength(64)),
  components: Schema.Array(Schema.String.pipe(Schema.maxLength(64))).pipe(Schema.maxItems(16)),
  // A public key; a real one is a few KB.
  signingKey: Schema.String.pipe(Schema.maxLength(65536)),
  reason: Schema.String.pipe(Schema.maxLength(2000)),
});

const AptRepositoryChangeResponse = Schema.Struct({
  approvalId: Schema.String,
  status: Schema.Literal("pending", "approved", "rejected", "expired"),
  fingerprint: Schema.optional(Schema.String),
});

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
    HttpApiEndpoint.get("listAptRepositories", "/api/v1/organisation/apt-repositories")
      .addSuccess(Schema.Struct({ items: Schema.Array(AptRepositoryResource) }))
      .middleware(CurrentUserAuthentication),
  )
  .add(
    // Asks to add one. Nothing is written until the `apt_repository` approval is granted.
    HttpApiEndpoint.post("addAptRepository", "/api/v1/organisation/apt-repositories")
      .setPayload(AddAptRepositoryPayload)
      .addSuccess(AptRepositoryChangeResponse, { status: 202 })
      .addError(AptRepositoryError, { status: 422 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.post("removeAptRepository", "/api/v1/organisation/apt-repositories/:id/remove")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .setPayload(Schema.Struct({ reason: Schema.String.pipe(Schema.maxLength(2000)) }))
      .addSuccess(AptRepositoryChangeResponse, { status: 202 })
      .addError(AptRepositoryError, { status: 422 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.patch("updatePackages", "/api/v1/organisation/packages")
      .setPayload(UpdateOrgPackagesPayload)
      .addSuccess(UpdateOrgPackagesResponse)
      .addError(PackageLockConflictError, { status: 422 })
      .addError(PackageEnsureSettingError, { status: 422 })
      .addError(OrgPackagesError, { status: 404 })
      .middleware(CurrentUserAuthentication),
  );
