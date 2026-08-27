import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { MachineService } from "../../domain/machine/MachineService";
import { Api } from "../api";

export const MachinesLive = HttpApiBuilder.group(Api, "machines", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const machineService = yield* MachineService;
        return yield* machineService
          .create({
            orgId: payload.orgId,
            name: payload.name,
            region: payload.region,
            sizeSku: payload.sizeSku,
            image: payload.image,
            ownerPersonId: payload.ownerPersonId,
            templateId: payload.templateId ?? null,
            actorPersonId: payload.actorPersonId ?? null,
          })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const machineService = yield* MachineService;
        const result = yield* machineService
          .list({ orgId: urlParams.orgId, cursor: urlParams.cursor, limit: urlParams.limit })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
        return {
          items: result.items,
          pageInfo: { nextCursor: result.nextCursor, hasMore: result.hasMore },
        };
      }),
    )
    .handle("byId", ({ path }) =>
      Effect.gen(function* () {
        const machineService = yield* MachineService;
        return yield* machineService
          .getById(path.id)
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    )
    .handle("updatePackages", ({ path, payload }) =>
      Effect.gen(function* () {
        const machineService = yield* MachineService;
        return yield* machineService
          .updatePackages({
            machineId: path.id,
            upserts: payload.upserts,
            removals: payload.removals,
            actorPersonId: payload.actorPersonId ?? null,
          })
          .pipe(Effect.catchTag("MachineServiceError", Effect.die));
      }),
    ),
);
