import type { ApiErrorBody } from "@cloudable/contracts";
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import { MachineService } from "../../domain/machine/MachineService";
import { upgradeMachine } from "../../domain/upgrade/UpgradeService";
import { UpgradeError } from "../../domain/upgrade/types";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";
import { mapErrorToResponse } from "../middleware/error-mapper";

const statusFor = (error: UpgradeError): number => {
  switch (error.reason) {
    case "machine_not_found":
      return 404;
    case "not_eligible":
      return 409;
    default:
      return 500;
  }
};

const errorBodyFor = (error: UpgradeError): ApiErrorBody => ({
  error: {
    code: error.reason,
    message:
      error.reason === "not_eligible"
        ? `Machine is not eligible for another upgrade attempt until ${error.nextEligibleAt?.toISOString()}.`
        : error.reason === "machine_not_found"
          ? "Machine not found."
          : "An unexpected error occurred while upgrading the machine.",
    requestId: ulid(),
    // `exactOptionalPropertyTypes`: only include `details` when there's
    // something to put in it, rather than assigning it `undefined`.
    ...(error.nextEligibleAt
      ? { details: { nextEligibleAt: error.nextEligibleAt.toISOString() } }
      : {}),
  },
});

export const UpgradeLive = HttpApiBuilder.group(Api, "upgrade", (handlers) =>
  handlers.handle("triggerUpgrade", ({ path, payload }) =>
    Effect.gen(function* () {
      const currentUser = yield* CurrentUserTag;
      // `upgradeMachine`'s own signature doesn't take an `orgId` — this
      // scoped fetch is the tenant-ownership gate in front of it, same
      // reasoning as `archive`/`offboarding`'s handlers. Reusing
      // `MachineService.getById`'s existing org check rather than
      // duplicating a second machine query here.
      const machineService = yield* MachineService;
      yield* machineService.getById(path.machineId, currentUser.orgId).pipe(
        Effect.catchTags({
          MachineNotFoundError: () =>
            Effect.fail(new UpgradeError({ reason: "machine_not_found", cause: path.machineId })),
          MachineServiceError: (cause) =>
            Effect.fail(new UpgradeError({ reason: "db_error", cause })),
        }),
      );
      return yield* upgradeMachine(path.machineId, payload.targetImage);
    }).pipe(
      Effect.map((result) => ({
        ...result,
        nextEligibleAt: result.nextEligibleAt.toISOString(),
      })),
      // Precondition failures (machine not found / still in backoff) map to
      // their own status codes. `HttpServerResponse.json` can itself fail to
      // serialize (`HttpBodyError`) — practically never for these plain
      // literal bodies, so `orDie` closes that channel rather than
      // threading it through the endpoint's (currently `never`) error type.
      Effect.catchTag("UpgradeError", (error) =>
        HttpServerResponse.json(errorBodyFor(error), { status: statusFor(error) }).pipe(
          Effect.orDie,
        ),
      ),
      // Anything else (an EventBus write failure, an unexpected defect) is a
      // genuine infra fault, not a modeled outcome — collapse to a 500.
      Effect.catchAll((cause) => mapErrorToResponse(cause, ulid()).pipe(Effect.orDie)),
    ),
  ),
);
