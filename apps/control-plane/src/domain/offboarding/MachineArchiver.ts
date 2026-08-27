import { Context, type Effect } from "effect";
import type { ArchiveError, MachineArchiveResult } from "../archive/archiveMachine";

/**
 * Port wrapping unit 15's archive logic (`domain/archive/archiveMachine`),
 * so `offboardPerson` can be unit-tested against a mock without touching
 * the database — mirrors how `ProvisioningServiceTag` wraps cloud
 * provisioning.
 */
export interface MachineArchiver {
  archive: (
    machineId: string,
    approvalId?: string,
  ) => Effect.Effect<MachineArchiveResult, ArchiveError>;
}

export class MachineArchiverTag extends Context.Tag("MachineArchiver")<
  MachineArchiverTag,
  MachineArchiver
>() {}
