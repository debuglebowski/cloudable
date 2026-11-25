import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { requireAdminUser } from "../../domain/authz";
import { requestOrgManifestEdit } from "../../domain/machine/package-ensure";
import type { OrgPackagesError } from "../../domain/organisation/packages";
import {
  archiveProfile,
  createProfile,
  getProfile,
  listProfiles,
  setBaseProfile,
  updateProfile,
} from "../../domain/profile/ProfileService";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

/** A missing or archived profile is the caller's to fix; any other reason is our infra. */
const rethrowPackagesInfraAsDefect = (e: OrgPackagesError) =>
  e.reason === "profile_not_found" || e.reason === "profile_archived"
    ? Effect.fail(e)
    : Effect.die(e);

// Reading profiles is open to anyone in the org: a member can see what their machine inherits.
// Every write is configuration, so admin only.
export const ProfilesLive = HttpApiBuilder.group(Api, "profiles", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.flatMap(CurrentUserTag, (currentUser) => listProfiles(currentUser.orgId)).pipe(
        Effect.map((items) => ({ items })),
      ),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can create a profile.");
        return yield* createProfile({
          orgId: currentUser.orgId,
          ...payload,
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }),
    )
    .handle("byId", ({ path }) =>
      Effect.flatMap(CurrentUserTag, (currentUser) =>
        getProfile(currentUser.orgId, path.id).pipe(
          // A profile is never mid-edit here, so the edit error cannot happen on a read.
          Effect.catchTag("ProfileEditError", Effect.die),
        ),
      ),
    )
    .handle("update", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can change a profile.");
        return yield* updateProfile({
          orgId: currentUser.orgId,
          profileId: path.id,
          ...payload,
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }),
    )
    .handle("archive", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can archive a profile.");
        // Refused while profiles that are not archived extend it.
        return yield* archiveProfile({
          orgId: currentUser.orgId,
          profileId: path.id,
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }),
    )
    .handle("setBase", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can change a profile's base.");
        return yield* setBaseProfile({
          orgId: currentUser.orgId,
          profileId: path.id,
          baseProfileId: payload.baseProfileId,
          actor: { actorType: "person", actorId: currentUser.personId },
        });
      }),
    )
    .handle("updatePackages", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(currentUser, "Only an admin can change a profile's packages.");
        // An edit that sets a package to Ensure waits for its approval, as on the org.
        return yield* requestOrgManifestEdit({
          orgId: currentUser.orgId,
          profileId: path.id,
          personId: currentUser.personId,
          upserts: payload.upserts,
          removals: payload.removals,
        });
      }).pipe(Effect.catchTag("OrgPackagesError", rethrowPackagesInfraAsDefect)),
    ),
);
