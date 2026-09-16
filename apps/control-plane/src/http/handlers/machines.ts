import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { MachineService } from "../../domain/machine/MachineService";
import { PackageActionRejected } from "../../domain/machine/errors";
import { machinePackageActionRequestedEvent } from "../../domain/machine/events";
import { enqueuePackageAction, toActionView } from "../../domain/machine/package-actions";
import { EventBus } from "../../services/EventBus";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

export const MachinesLive = HttpApiBuilder.group(Api, "machines", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
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
            templateId: payload.templateId ?? null,
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
          .list({ orgId: currentUser.orgId, cursor: urlParams.cursor, limit: urlParams.limit })
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
        const machineService = yield* MachineService;
        return yield* machineService
          .getById(path.id, currentUser.orgId)
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("updatePackages", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const machineService = yield* MachineService;
        return yield* machineService
          .updatePackages({
            machineId: path.id,
            orgId: currentUser.orgId,
            upserts: payload.upserts,
            removals: payload.removals,
            actorPersonId: currentUser.personId,
          })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("packages", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const machineService = yield* MachineService;
        return yield* machineService
          .packagesView(path.id, currentUser.orgId)
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("createPackageAction", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const machineService = yield* MachineService;
        const db = yield* Db;
        const eventBus = yield* EventBus;

        // Read the table first: it is the one place that already knows this
        // package's pin, and whether it came with the image.
        const view = yield* machineService
          .packagesView(path.id, currentUser.orgId)
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
        const row = view.items.find((item) => item.packageName === path.packageName);

        const correlationId = ulid();
        const action = yield* enqueuePackageAction(db, {
          machineId: path.id,
          orgId: currentUser.orgId,
          packageName: path.packageName,
          op: payload.op,
          versionPin: row?.versionPin ?? null,
          requestedByPersonId: currentUser.personId,
          correlationId,
          isBaselinePackage: row?.isBaseline ?? false,
        }).pipe(
          Effect.mapError(
            (error) =>
              new PackageActionRejected({
                error: {
                  code: error.reason === "machine_not_found" ? "write_failed" : error.reason,
                  message: error.message,
                  requestId: correlationId,
                },
              }),
          ),
        );

        yield* eventBus
          .publish([
            machinePackageActionRequestedEvent({
              machineId: path.id,
              orgId: currentUser.orgId,
              correlationId,
              actorType: "person",
              actorId: currentUser.personId,
              actionId: action.id,
              packageName: action.packageName,
              op: action.op,
              versionPin: action.versionPin,
            }),
          ])
          .pipe(Effect.orDie);

        return { action: toActionView(action) };
      }),
    )
    .handle("manifestHistory", ({ path, urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
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
