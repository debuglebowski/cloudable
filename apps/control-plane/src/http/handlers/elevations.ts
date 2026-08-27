import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ElevationService } from "../../domain/elevation/ElevationService";
import { Api } from "../api";
import { toWire } from "../routes/elevations";

export const ElevationsLive = HttpApiBuilder.group(Api, "elevations", (handlers) =>
  handlers
    .handle("request", ({ payload }) =>
      Effect.gen(function* () {
        const elevationService = yield* ElevationService;
        return toWire(yield* elevationService.request(payload));
      }),
    )
    .handle("get", ({ path }) =>
      Effect.gen(function* () {
        const elevationService = yield* ElevationService;
        return toWire(yield* elevationService.get(path.id));
      }),
    )
    .handle("sync", ({ path }) =>
      Effect.gen(function* () {
        const elevationService = yield* ElevationService;
        return toWire(yield* elevationService.syncApproval(path.id));
      }),
    )
    .handle("expire", ({ path }) =>
      Effect.gen(function* () {
        const elevationService = yield* ElevationService;
        yield* elevationService.expire(path.id);
        return toWire(yield* elevationService.get(path.id));
      }),
    ),
);
