import { machines } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { buildEvent } from "../build-event";
import { MachineNotFoundError, MachineNotRunningError } from "./errors";

/** Our own DB read/write or event publication failed unexpectedly — never a declared
 * HTTP error (same role as `domain/archive/errors.ts`'s `ArchiveDbError`), always
 * `Effect.die`'d at the HTTP boundary. */
export class MachineRestartDbError extends Data.TaggedError("MachineRestartDbError")<{
  reason: string;
}> {}

const notFound = (machineId: string) =>
  new MachineNotFoundError({
    error: { code: "not_found", message: `Machine ${machineId} not found`, requestId: ulid() },
  });

const notRunning = (machineId: string, state: string) =>
  new MachineNotRunningError({
    error: {
      code: "machine_not_running",
      message: `Machine ${machineId} is ${state}, not running`,
      requestId: ulid(),
    },
  });

/**
 * Reboots a machine's underlying compute in place: `ProvisioningService.restart()`
 * cycles the running process (no archive-lifecycle or reimage-lifecycle side effects —
 * the machine keeps its existing identity, declared packages, and `machines.state`
 * throughout, only `lastVerifiedAt` moves). Reuses the already-catalogued
 * `machine.stopped`/`machine.started` event pair (`packages/events`) rather than adding
 * a third event type — `machine.started` was reserved but never emitted anywhere in
 * this build before this.
 *
 * Only valid for a `"running"` machine — a stopped/archived/errored/still-provisioning
 * one has nothing live to reboot.
 */
export const restartMachine = (machineId: string, orgId: string, actorPersonId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const provisioning = yield* ProvisioningServiceTag;
    const eventBus = yield* EventBus;

    const rows = yield* Effect.tryPromise({
      try: () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
      catch: (cause) => new MachineRestartDbError({ reason: `fetch_machine: ${String(cause)}` }),
    });
    const machine = rows[0];
    if (!machine || machine.orgId !== orgId) {
      return yield* Effect.fail(notFound(machineId));
    }
    if (machine.state !== "running") {
      return yield* Effect.fail(notRunning(machineId, machine.state));
    }

    yield* provisioning.restart(machineId);

    const now = new Date();
    yield* Effect.tryPromise({
      try: () => db.update(machines).set({ lastVerifiedAt: now }).where(eq(machines.id, machineId)),
      catch: (cause) =>
        new MachineRestartDbError({ reason: `update_last_verified_at: ${String(cause)}` }),
    });

    const correlationId = ulid();
    yield* eventBus.publish([
      buildEvent("machine.stopped", {
        orgId,
        actorType: "person",
        actorId: actorPersonId,
        machineId,
        correlationId,
        payload: { initiator: "user" },
      }),
      buildEvent("machine.started", {
        orgId,
        actorType: "person",
        actorId: actorPersonId,
        machineId,
        correlationId,
        payload: {},
      }),
    ]).pipe(
      Effect.mapError(
        (cause) => new MachineRestartDbError({ reason: `event_publish_failed: ${cause.reason}` }),
      ),
    );

    return { machineId, state: "running" as const, restartedAt: now.toISOString() };
  });
