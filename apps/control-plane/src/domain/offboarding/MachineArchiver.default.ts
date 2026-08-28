import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { archiveMachine } from "../archive/archive";
import { type MachineArchiver, MachineArchiverTag } from "./MachineArchiver";

/**
 * Default `MachineArchiver` — delegates to unit 15's real
 * `domain/archive/archive.ts`'s `archiveMachine`, resolving `Db`/`EventBus`/
 * `ProvisioningServiceTag` once at layer construction so the port itself
 * carries no further requirements. Used by the running server.
 */
export const DefaultMachineArchiverLive = Layer.effect(
  MachineArchiverTag,
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;

    const archive: MachineArchiver["archive"] = (machineId, approvalId) =>
      archiveMachine(machineId, approvalId).pipe(
        Effect.provideService(Db, db),
        Effect.provideService(EventBus, eventBus),
        Effect.provideService(ProvisioningServiceTag, provisioning),
      );

    return { archive } satisfies MachineArchiver;
  }),
);
