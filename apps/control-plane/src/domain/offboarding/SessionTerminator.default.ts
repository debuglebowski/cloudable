import { Effect, Layer } from "effect";
import { TunnelRelay } from "../../tunnel/relay";
import { type SessionTerminator, SessionTerminatorTag } from "./SessionTerminator";

/**
 * Default `SessionTerminator` — delegates to the real
 * `TunnelRelay.terminateSessionsForMachine` (DB update + event, then the
 * actual live-connection teardown via `TunnelRegistry`), resolving
 * `TunnelRelay` once at layer construction so the port itself carries no
 * further requirements. Used by the running server.
 */
export const DefaultSessionTerminatorLive = Layer.effect(
  SessionTerminatorTag,
  Effect.gen(function* () {
    const relay = yield* TunnelRelay;

    const terminateForMachine: SessionTerminator["terminateForMachine"] = (
      orgId,
      machineId,
      reason,
    ) => relay.terminateSessionsForMachine({ orgId, machineId, reason }).pipe(Effect.asVoid);

    return { terminateForMachine } satisfies SessionTerminator;
  }),
);
