import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { PackageEnsureSettingError, PackageLockConflictError } from "../../domain/machine/errors";
import { OrgPackagesError } from "../../domain/organisation/packages";
import {
  ProfileEditError,
  ProfileNotFoundError,
  ProfileWriteError,
} from "../../domain/profile/errors";
import { CurrentUserAuthentication } from "../middleware/auth";
import {
  OrgPackageEntryResource,
  UpdateOrgPackagesPayload,
  UpdateOrgPackagesResponse,
} from "./organisation";

// Profiles: named sets of settings machines link to (org → profile → machine). A profile
// may extend one base profile: org → base → profile → machine.
// A profile's settings are written through `PATCH /api/v1/config/settings` with
// `scopeType: "profile"`; its packages through `PATCH /api/v1/profiles/:id/packages`.
// See docs/inheritance.md.

const providerSchema = Schema.Literal("azure", "docker", "fake");

const ResolvedCreationField = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  locked: Schema.Boolean,
  fromProfileId: Schema.NullOr(Schema.String),
});

export const ProfileResource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(providerSchema),
  region: Schema.NullOr(Schema.String),
  sizeSku: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  providerLocked: Schema.Boolean,
  regionLocked: Schema.Boolean,
  sizeLocked: Schema.Boolean,
  imageLocked: Schema.Boolean,
  /**
   * What a machine created on this profile gets for each creation field. Unlocked: a starting
   * value the machine may change. Locked: every machine on the profile has it.
   */
  creation: Schema.Struct({
    provider: ResolvedCreationField,
    region: ResolvedCreationField,
    sizeSku: ResolvedCreationField,
    image: ResolvedCreationField,
  }),
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  machineCount: Schema.Number,
  /** The profile this one extends, or null. */
  baseProfileId: Schema.NullOr(Schema.String),
  baseProfileName: Schema.NullOr(Schema.String),
  /** Profiles that are not archived and extend this one. */
  extendedBy: Schema.Number,
});

const ProfileSettingResource = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
  locked: Schema.Boolean,
});

const ProfileDetailResource = Schema.Struct({
  ...ProfileResource.fields,
  settings: Schema.Array(ProfileSettingResource),
  packages: Schema.Array(OrgPackageEntryResource),
  /** The base's own settings and packages: what this profile inherits from it. */
  base: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      settings: Schema.Array(ProfileSettingResource),
      packages: Schema.Array(OrgPackageEntryResource),
    }),
  ),
});

const name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100));
const description = Schema.NullOr(Schema.String.pipe(Schema.maxLength(500)));
const field = Schema.NullOr(Schema.String);

const CreateProfilePayload = Schema.Struct({
  name,
  description: Schema.optional(description),
  baseProfileId: Schema.optional(Schema.NullOr(Schema.UUID)),
  provider: Schema.optional(Schema.NullOr(providerSchema)),
  region: Schema.optional(field),
  sizeSku: Schema.optional(field),
  image: Schema.optional(field),
  providerLocked: Schema.optional(Schema.Boolean),
  regionLocked: Schema.optional(Schema.Boolean),
  sizeLocked: Schema.optional(Schema.Boolean),
  imageLocked: Schema.optional(Schema.Boolean),
});

const UpdateProfilePayload = Schema.Struct({
  name: Schema.optional(name),
  description: Schema.optional(description),
  provider: Schema.optional(Schema.NullOr(providerSchema)),
  region: Schema.optional(field),
  sizeSku: Schema.optional(field),
  image: Schema.optional(field),
  providerLocked: Schema.optional(Schema.Boolean),
  regionLocked: Schema.optional(Schema.Boolean),
  sizeLocked: Schema.optional(Schema.Boolean),
  imageLocked: Schema.optional(Schema.Boolean),
});

const profileIdPath = Schema.Struct({ id: Schema.UUID });

const SetBaseProfilePayload = Schema.Struct({ baseProfileId: Schema.NullOr(Schema.UUID) });

export const ProfilesGroup = HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(Schema.Struct({ items: Schema.Array(ProfileResource) }))
      .addError(ProfileWriteError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateProfilePayload)
      .addSuccess(ProfileResource, { status: 201 })
      .addError(ProfileEditError, { status: 422 })
      .addError(ProfileWriteError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("byId", "/:id")
      .setPath(profileIdPath)
      .addSuccess(ProfileDetailResource)
      .addError(ProfileNotFoundError, { status: 404 })
      .addError(ProfileWriteError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/:id")
      .setPath(profileIdPath)
      .setPayload(UpdateProfilePayload)
      .addSuccess(ProfileResource)
      .addError(ProfileNotFoundError, { status: 404 })
      .addError(ProfileEditError, { status: 422 })
      .addError(ProfileWriteError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("archive", "/:id/archive")
      .setPath(profileIdPath)
      .addSuccess(ProfileResource)
      .addError(ProfileNotFoundError, { status: 404 })
      .addError(ProfileEditError, { status: 422 })
      .addError(ProfileWriteError, { status: 500 }),
  )
  .add(
    // Sets the profile this one extends, or clears it (`baseProfileId: null`).
    HttpApiEndpoint.put("setBase", "/:id/base")
      .setPath(profileIdPath)
      .setPayload(SetBaseProfilePayload)
      .addSuccess(ProfileResource)
      .addError(ProfileNotFoundError, { status: 404 })
      .addError(ProfileEditError, { status: 422 })
      .addError(ProfileWriteError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.patch("updatePackages", "/:id/packages")
      .setPath(profileIdPath)
      .setPayload(UpdateOrgPackagesPayload)
      .addSuccess(UpdateOrgPackagesResponse)
      .addError(PackageLockConflictError, { status: 422 })
      .addError(PackageEnsureSettingError, { status: 422 })
      .addError(OrgPackagesError, { status: 404 }),
  )
  .prefix("/api/v1/profiles")
  .middleware(CurrentUserAuthentication);
