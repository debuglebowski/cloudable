import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ElevationService } from "../../domain/elevation/ElevationService";
import { listElevationsByOrg } from "../../domain/elevation/queries";
import { ElevationInfraError } from "../../domain/elevation/types";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";
import { toWire } from "../routes/elevations";

export const ElevationsLive = HttpApiBuilder.group(Api, "elevations", (handlers) =>
  handlers
    .handle("request", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const elevationService = yield* ElevationService;
        return toWire(
          yield* elevationService.request({ ...payload, personId: currentUser.personId }),
        );
      }),
    )
    .handle("get", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const elevationService = yield* ElevationService;
        return toWire(yield* elevationService.get(path.id, currentUser.orgId));
      }),
    )
    .handle("sync", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const elevationService = yield* ElevationService;
        return toWire(yield* elevationService.syncApproval(path.id, currentUser.orgId));
      }),
    )
    .handle("expire", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const elevationService = yield* ElevationService;
        yield* elevationService.expire(path.id, currentUser.orgId);
        return toWire(yield* elevationService.get(path.id, currentUser.orgId));
      }),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* listElevationsByOrg(currentUser.orgId);
      }).pipe(
        Effect.map((rows) => ({
          elevations: rows.map((row) => ({
            id: row.id,
            personId: row.personId,
            machineId: row.machineId,
            machineName: row.machineName,
            level: row.level,
            reason: row.reason,
            status: row.status,
            expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          })),
        })),
        Effect.catchTag("ElevationQueryError", (e) =>
          Effect.fail(new ElevationInfraError({ reason: e.reason })),
        ),
      ),
    ),
);
