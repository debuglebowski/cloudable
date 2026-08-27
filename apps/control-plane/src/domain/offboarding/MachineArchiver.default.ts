import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { archiveMachine } from "../archive/archiveMachine";
import { type MachineArchiver, MachineArchiverTag } from "./MachineArchiver";

/**
 * Default `MachineArchiver` — delegates to `domain/archive/archiveMachine`
 * (unit 15's stub until unit 15 merges), resolving `Db`/`EventBus` once at
 * layer construction so the port itself carries no further requirements.
 * Used by the running server.
 */
export const DefaultMachineArchiverLive = Layer.effect(
  MachineArchiverTag,
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    const archive: MachineArchiver["archive"] = (machineId, approvalId) =>
      archiveMachine(machineId, approvalId).pipe(
        Effect.provideService(Db, db),
        Effect.provideService(EventBus, eventBus),
      );

    return { archive } satisfies MachineArchiver;
  }),
);
