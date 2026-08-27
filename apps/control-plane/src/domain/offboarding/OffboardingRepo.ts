import { Context, Data, type Effect } from "effect";

export class OffboardingRepoError extends Data.TaggedError("OffboardingRepoError")<{
  reason: "db_error";
  cause?: unknown;
}> {}

export interface OffboardingPerson {
  id: string;
  orgId: string;
}

export interface OwnedMachine {
  id: string;
}

/**
 * The offboarding-specific slice of persistence: looking up the person and
 * the machines they currently own, the person's still-live certificates,
 * and the two machine-row mutations offboarding itself owns (state ->
 * stopped, owner cleared). Kept as its own port — distinct from the
 * `CertificateRevoker` and `MachineArchiver` ports, which wrap unit
 * 12/15's business logic — so `offboardPerson`'s unit tests can run
 * against an in-memory fake with zero real Postgres/Drizzle involved.
 */
export interface OffboardingRepo {
  findPerson: (personId: string) => Effect.Effect<OffboardingPerson | null, OffboardingRepoError>;
  findOwnedMachines: (personId: string) => Effect.Effect<OwnedMachine[], OffboardingRepoError>;
  findLiveCertificateIds: (personId: string) => Effect.Effect<string[], OffboardingRepoError>;
  markMachineStopped: (machineId: string) => Effect.Effect<void, OffboardingRepoError>;
  clearMachineOwner: (machineId: string) => Effect.Effect<void, OffboardingRepoError>;
}

export class OffboardingRepoTag extends Context.Tag("OffboardingRepo")<
  OffboardingRepoTag,
  OffboardingRepo
>() {}
