import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import { getAgentRelease } from "../../domain/agent-update/release";
import { authorizeMachine, ownOnlyFilter, requireAdminUser } from "../../domain/authz";
import { MachineService } from "../../domain/machine/MachineService";
import { DEFAULT_COMPUTE_HOURS, machineCompute } from "../../domain/machine/compute";
import { MachineNotFoundError } from "../../domain/machine/errors";
import { toActionView } from "../../domain/machine/package-actions";
import { requestMachineManifestEdit } from "../../domain/machine/package-ensure";
import { requestPackageAction } from "../../domain/machine/package-request";
import { requestMachineResize } from "../../domain/machine/resize";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";
import { toApprovalWire } from "../routes/approvals";

export const MachinesLive = HttpApiBuilder.group(Api, "machines", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // Members do not create machines. An admin creates one for a person, and
        // `MachineService.create` checks that person is active, in this org, and has no
        // other live machine.
        yield* requireAdminUser(currentUser, "Only an admin can create a machine.");
        const machineService = yield* MachineService;
        return yield* machineService
          .create({
            orgId: currentUser.orgId,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            provider: payload.provider,
            region: payload.region ?? null,
            sizeSku: payload.sizeSku,
            image: payload.image,
            ownerPersonId: payload.ownerPersonId,
            profileId: payload.profileId ?? null,
            actorPersonId: currentUser.personId,
          })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const machineService = yield* MachineService;
        const result = yield* machineService
          .list({
            orgId: currentUser.orgId,
            ownerPersonId: ownOnlyFilter(currentUser),
            cursor: urlParams.cursor,
            limit: urlParams.limit,
          })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
        return {
          items: result.items,
          pageInfo: { nextCursor: result.nextCursor, hasMore: result.hasMore },
        };
      }),
    )
    .handle("byId", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* authorizeMachine(currentUser, path.id);
        const machineService = yield* MachineService;
        const machine = yield* machineService
          .getById(path.id, currentUser.orgId)
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
        const release = getAgentRelease();
        return {
          ...machine,
          desiredAgentRelease: release
            ? { version: release.version, releaseId: release.releaseId }
            : null,
        };
      }),
    )
    .handle("compute", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // The same people who may restart it: the owner or an admin.
        yield* authorizeMachine(currentUser, path.id, "restart");
        const hours = Math.min(
          Math.max(Math.round(urlParams.hours ?? DEFAULT_COMPUTE_HOURS), 1),
          720,
        );
        const compute = yield* machineCompute(path.id, currentUser.orgId, hours);
        if (!compute) {
          return yield* Effect.fail(
            new MachineNotFoundError({
              error: {
                code: "not_found",
                message: `Machine ${path.id} not found`,
                requestId: ulid(),
              },
            }),
          );
        }
        return compute;
      }),
    )
    .handle("resize", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* authorizeMachine(currentUser, path.id, "resize");
        return yield* requestMachineResize({
          machineId: path.id,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
          sizeSku: payload.sizeSku,
          reason: payload.reason,
        });
      }),
    )
    .handle("setProfile", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // Which profile a machine is on is configuration, the same as creating it on one.
        yield* requireAdminUser(
          currentUser,
          "Only an admin can move a machine to another profile.",
        );
        const machineService = yield* MachineService;
        return yield* machineService
          .setProfile({
            machineId: path.id,
            orgId: currentUser.orgId,
            profileId: payload.profileId,
            actorPersonId: currentUser.personId,
          })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("updatePackages", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* authorizeMachine(currentUser, path.id, "editManifest");
        // An edit that sets a package to Ensure waits for its approval; everything else applies now.
        return yield* requestMachineManifestEdit({
          machineId: path.id,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
          upserts: payload.upserts,
          removals: payload.removals,
        }).pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("packages", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* authorizeMachine(currentUser, path.id);
        const machineService = yield* MachineService;
        return yield* machineService
          .packagesView(path.id, currentUser.orgId)
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("createPackageAction", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // The owner may ask on their own machine, an admin on any. An install then waits for
        // an approver unless the org set `package_install` to "none"; a removal is queued.
        yield* authorizeMachine(currentUser, path.id, "packages");
        const result = yield* requestPackageAction({
          machineId: path.id,
          orgId: currentUser.orgId,
          personId: currentUser.personId,
          packageName: path.packageName,
          op: payload.op,
          reason: payload.reason,
        });
        return {
          action: result.action ? toActionView(result.action) : null,
          approval: result.approval ? toApprovalWire(result.approval) : null,
        };
      }),
    )
    .handle("manifestHistory", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* authorizeMachine(currentUser, path.id);
        const machineService = yield* MachineService;
        return yield* machineService
          .manifestHistory({
            orgId: currentUser.orgId,
            machineId: path.id,
            limit: urlParams.limit,
            cursor: urlParams.cursor,
          })
          .pipe(Effect.catchTag("ManifestHistoryError", Effect.die));
      }),
    ),
);
