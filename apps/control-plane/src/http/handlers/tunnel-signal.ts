import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { AgentSessionToken } from "../../services/attestation/AgentSessionToken";
import { MachineDirectory } from "../../services/attestation/MachineDirectory";
import { TunnelSignal } from "../../tunnel/signal";
import { Api } from "../api";
import { bearerToken } from "../bearer-token";
import { TunnelSignalUnauthorized } from "../routes/tunnel-signal";

export const TunnelSignalLive = HttpApiBuilder.group(Api, "tunnel-signal", (handlers) =>
  handlers.handle("next", ({ request }) =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessionToken;
      const directory = yield* MachineDirectory;
      const signal = yield* TunnelSignal;

      const token = bearerToken(request.headers.authorization);
      if (!token) {
        return yield* Effect.fail(new TunnelSignalUnauthorized({ reason: "missing_bearer_token" }));
      }
      const identity = yield* sessions
        .verify(token)
        .pipe(Effect.mapError((error) => new TunnelSignalUnauthorized({ reason: error.reason })));

      // Same re-check `report` does (agent-protocol.ts) and `attest` does more strictly
      // still — a bearer session outlives the machine it was minted for by up to its own
      // TTL (`AgentSessionToken`'s ~15 min default), and unlike `report`/`poll` (which only
      // ever hand back inert desired-state data), this channel can actively tell an agent
      // "a session exists, connect to it" — so an archived or reassigned machine's agent
      // must not keep being told about live sessions for however long its stale bearer
      // session happens to still verify.
      const machine = yield* directory.findById(identity.machineId);
      const rejectionReason = !machine
        ? "machine_not_found"
        : machine.orgId !== identity.orgId
          ? "machine_not_found"
          : machine.state.startsWith("archived")
            ? "machine_archived"
            : null;
      if (rejectionReason) {
        return yield* Effect.fail(new TunnelSignalUnauthorized({ reason: rejectionReason }));
      }

      const nextSignal = yield* signal.next(identity.machineId);
      return { signal: nextSignal };
    }),
  ),
);
