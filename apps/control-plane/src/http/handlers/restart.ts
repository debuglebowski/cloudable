import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { restartMachine } from "../../domain/machine/restart";
import { TunnelRelay } from "../../tunnel/relay";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

export const RestartLive = HttpApiBuilder.group(Api, "restart", (handlers) =>
  handlers.handle("restartMachine", ({ path }) =>
    Effect.gen(function* () {
      const currentUser = yield* CurrentUserTag;
      const result = yield* restartMachine(path.machineId, currentUser.orgId, currentUser.personId);
      // Restarting kills the container/VM process, so any live web terminal against it
      // is already dead — tell the browser rather than let it hang, same requirement
      // `ArchiveLive`'s `archiveMachine` handler honors.
      const tunnelRelay = yield* TunnelRelay;
      yield* tunnelRelay.terminateSessionsForMachine({
        orgId: currentUser.orgId,
        machineId: path.machineId,
        reason: "machine_restarted",
      });
      return result;
    }).pipe(
      // `MachineNotFoundError`/`MachineNotRunningError` are declared via `.addError` in
      // ../routes/restart.ts and flow through untouched. Everything else here is our
      // own infra breaking, not a meaningful outcome for an API caller.
      Effect.catchTags({
        ProvisioningError: (e) => Effect.die(e),
        MachineRestartDbError: (e) => Effect.die(e),
        TunnelError: (e) => Effect.die(e),
      }),
    ),
  ),
);
