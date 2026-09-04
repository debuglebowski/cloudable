import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { MachineNotFoundError, MachineNotRunningError } from "../../domain/machine/errors";
import { CurrentUserAuthentication } from "../middleware/auth";

/**
 * `POST /api/v1/machines/:machineId/restart` — reboots a running machine's underlying
 * compute in place. See `apps/control-plane/src/domain/machine/restart.ts` for the
 * actual `ProvisioningService.restart()` + `machine.stopped`/`machine.started` event
 * pair this endpoint drives.
 */
export const RestartResponse = Schema.Struct({
  machineId: Schema.String,
  state: Schema.Literal("running"),
  restartedAt: Schema.String,
});

export const RestartGroup = HttpApiGroup.make("restart")
  .add(
    HttpApiEndpoint.post(
      "restartMachine",
    )`/api/v1/machines/${HttpApiSchema.param("machineId", Schema.String)}/restart`
      .addSuccess(RestartResponse)
      .addError(MachineNotFoundError, { status: 404 })
      .addError(MachineNotRunningError, { status: 409 }),
  )
  .middleware(CurrentUserAuthentication);
