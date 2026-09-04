import { certificates, machines, people } from "@cloudable/schema";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { type OffboardingRepo, OffboardingRepoError, OffboardingRepoTag } from "./OffboardingRepo";

/** Real, Drizzle/Postgres-backed `OffboardingRepo`. Used by the running server. */
export const DrizzleOffboardingRepoLive = Layer.effect(
  OffboardingRepoTag,
  Effect.gen(function* () {
    const db = yield* Db;

    const findPerson: OffboardingRepo["findPerson"] = (personId) =>
      Effect.tryPromise({
        try: async () => {
          const [row] = await db.select().from(people).where(eq(people.id, personId)).limit(1);
          return row ? { id: row.id, orgId: row.orgId } : null;
        },
        catch: (cause) => new OffboardingRepoError({ reason: "db_error", cause }),
      });

    const findOwnedMachines: OffboardingRepo["findOwnedMachines"] = (personId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ id: machines.id, provider: machines.provider })
            .from(machines)
            .where(
              and(
                eq(machines.ownerPersonId, personId),
                // Defensive: a machine already archived (by any path) but whose
                // owner was never cleared should not be re-stopped/re-archived
                // by a subsequent offboarding call for the same person.
                notInArray(machines.state, ["archived_restorable", "archived_expired"]),
              ),
            );
          return rows;
        },
        catch: (cause) => new OffboardingRepoError({ reason: "db_error", cause }),
      });

    const findLiveCertificateIds: OffboardingRepo["findLiveCertificateIds"] = (personId) =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ id: certificates.id })
            .from(certificates)
            .where(and(eq(certificates.personId, personId), isNull(certificates.revokedAt)));
          return rows.map((r) => r.id);
        },
        catch: (cause) => new OffboardingRepoError({ reason: "db_error", cause }),
      });

    const markMachineStopped: OffboardingRepo["markMachineStopped"] = (machineId) =>
      Effect.tryPromise({
        try: () => db.update(machines).set({ state: "stopped" }).where(eq(machines.id, machineId)),
        catch: (cause) => new OffboardingRepoError({ reason: "db_error", cause }),
      }).pipe(Effect.asVoid);

    const clearMachineOwner: OffboardingRepo["clearMachineOwner"] = (machineId) =>
      Effect.tryPromise({
        try: () =>
          db.update(machines).set({ ownerPersonId: null }).where(eq(machines.id, machineId)),
        catch: (cause) => new OffboardingRepoError({ reason: "db_error", cause }),
      }).pipe(Effect.asVoid);

    return {
      findPerson,
      findOwnedMachines,
      findLiveCertificateIds,
      markMachineStopped,
      clearMachineOwner,
    } satisfies OffboardingRepo;
  }),
);
