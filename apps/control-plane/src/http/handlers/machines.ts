import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { MachineService } from "../../domain/machine/MachineService";
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
            name: payload.name,
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
    ),
);
