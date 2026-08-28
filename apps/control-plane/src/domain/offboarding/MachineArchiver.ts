import { Context, type Effect } from "effect";
import type { ProvisioningError } from "../../services/ProvisioningService";
import type {
  ArchiveDbError,
  MachineAlreadyArchivedError,
  MachineNotFoundError,
} from "../archive/errors";

/**
 * Port wrapping unit 15's real archive logic (`domain/archive/archive.ts`'s
 * `archiveMachine`), so `offboardPerson` can be unit-tested against a mock
 * without touching the database — mirrors how `ProvisioningServiceTag`
 * wraps cloud provisioning.
 */
export interface MachineArchiver {
  archive: (
    machineId: string,
    approvalId?: string,
  ) => Effect.Effect<
    void,
    ArchiveDbError | MachineAlreadyArchivedError | MachineNotFoundError | ProvisioningError
  >;
}

export class MachineArchiverTag extends Context.Tag("MachineArchiver")<
  MachineArchiverTag,
  MachineArchiver
>() {}
