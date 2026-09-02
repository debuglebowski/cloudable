import { Context, type Effect } from "effect";
import type { TunnelError } from "../../tunnel/server";

/**
 * Port wrapping `TunnelRelay.terminateSessionsForMachine` — must
 * terminate live sessions on policy change, and disabling
 * terminates live sessions — archiving a machine, whether directly via
 * the Archive page or as part of offboarding, ends any live terminal/SSH
 * session on it, not merely blocks new ones from starting. Narrow port,
 * same reasoning as `MachineArchiver`/`CertificateRevoker`: lets
 * `offboardPerson` be unit-tested against a mock without needing
 * `TunnelServer`'s Db/EventBus/Signer machinery pulled into every test.
 */
export interface SessionTerminator {
  terminateForMachine: (
    orgId: string,
    machineId: string,
    reason: string,
  ) => Effect.Effect<void, TunnelError>;
}

export class SessionTerminatorTag extends Context.Tag("SessionTerminator")<
  SessionTerminatorTag,
  SessionTerminator
>() {}
