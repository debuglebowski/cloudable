// ---------------------------------------------------------------------------
// Stopping and starting a machine, to save money (CLAUDE.md invariant 10: a machine
// changes only through a recorded action a person asked for).
//
// This is not idle suspend. Nothing here runs on a timer or a signal: the owner or an
// admin presses Stop, and later Start. No approval: stopping saves money, and starting
// brings back what was already approved.
//
// A stopped Azure machine is deallocated: no compute is billed, disks stay. Start brings
// it back exactly as it was. The provider call takes minutes, so it runs in the
// background, like a resize. The outcome is recorded as `machine.stopped` /
// `machine.started`, or `machine.stop_failed` / `machine.start_failed`.
// ---------------------------------------------------------------------------
import { machines } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { buildEvent } from "../build-event";
import { MachineNotFoundError, MachinePowerConflictError } from "./errors";

export type PowerAction = "stop" | "start";
export type PowerTransition = "stopping" | "starting";

/**
 * Machines with a stop or start under way in this process. Held in memory, not in the
 * database: the background work it tracks lives in this process too, and dies with it.
 * After a restart of the control plane the status refresh pass reads the real power
 * state from the provider again.
 */
const inFlight = new Map<string, PowerTransition>();

/** `stopping` or `starting` while that is under way, else null. Read by the machine page
 * and by the tunnel, which refuses new sessions on a machine that is stopping. */
export const powerTransitionFor = (machineId: string): PowerTransition | null =>
  inFlight.get(machineId) ?? null;

const dbTry = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(`${message}: ${String(cause)}`) });

const conflict = (code: MachinePowerConflictError["error"]["code"], message: string) =>
  Effect.fail(new MachinePowerConflictError({ error: { code, message, requestId: ulid() } }));

const ARCHIVED = new Set(["archived_restorable", "archived_expired"]);

/**
 * Checks the machine can be stopped (or started) now, and starts the work in the
 * background. Returns at once. The caller has already checked the person may do this
 * (`MachineAction` "power").
 */
export const requestMachinePower = (input: {
  machineId: string;
  orgId: string;
  personId: string;
  action: PowerAction;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry("reading machine", () =>
      db.select().from(machines).where(eq(machines.id, input.machineId)).limit(1),
    ).pipe(Effect.orDie);
    const machine = rows[0];
    if (!machine || machine.orgId !== input.orgId) {
      return yield* Effect.fail(
        new MachineNotFoundError({
          error: {
            code: "not_found",
            message: `Machine ${input.machineId} not found`,
            requestId: ulid(),
          },
        }),
      );
    }

    const busy = inFlight.get(machine.id);
    if (busy) {
      return yield* conflict(
        "machine_busy",
        `The machine is already ${busy}. Wait for it to finish.`,
      );
    }
    if (ARCHIVED.has(machine.state)) {
      return yield* conflict(
        input.action === "stop" ? "machine_not_running" : "machine_not_stopped",
        "The machine is archived. It cannot be stopped or started.",
      );
    }
    if (input.action === "stop" && machine.state !== "running") {
      return yield* conflict(
        "machine_not_running",
        machine.state === "stopped"
          ? "The machine is already stopped."
          : `The machine is ${machine.state}. Only a running machine can be stopped.`,
      );
    }
    if (input.action === "start" && machine.state !== "stopped") {
      return yield* conflict(
        "machine_not_stopped",
        machine.state === "running"
          ? "The machine is already running."
          : `The machine is ${machine.state}. Only a stopped machine can be started.`,
      );
    }

    // Set before anything else yields, so a second request in the same moment sees it.
    const transition: PowerTransition = input.action === "stop" ? "stopping" : "starting";
    inFlight.set(machine.id, transition);
    yield* Effect.forkDaemon(
      runPower({
        machineId: machine.id,
        orgId: machine.orgId,
        personId: input.personId,
        action: input.action,
        provider: machine.provider,
        externalId: machine.externalResourceId,
      }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(machine.id)))),
    );
    return { machineId: machine.id, state: transition };
  });

/**
 * The provider call and its record. Never fails its caller: the outcome is recorded either
 * way. A failure keeps the machine's state and puts the provider's reason on `lastError`.
 */
const runPower = (input: {
  machineId: string;
  orgId: string;
  personId: string;
  action: PowerAction;
  provider: "azure" | "docker" | "fake";
  externalId: string | null;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;
    const target = {
      machineId: input.machineId,
      provider: input.provider,
      externalId: input.externalId,
    };
    const outcome = yield* Effect.either(
      input.action === "stop" ? provisioning.stop(target) : provisioning.start(target),
    );
    const envelope = {
      orgId: input.orgId,
      actorType: "person" as const,
      actorId: input.personId,
      machineId: input.machineId,
      correlationId: ulid(),
    };

    if (outcome._tag === "Left") {
      const reason = String(outcome.left.cause ?? outcome.left.reason).slice(0, 500);
      yield* dbTry("recording failure", () =>
        db
          .update(machines)
          .set({ lastError: `${input.action} failed: ${reason}` })
          .where(eq(machines.id, input.machineId)),
      );
      yield* eventBus.publish([
        input.action === "stop"
          ? buildEvent("machine.stop_failed", { ...envelope, payload: { reason } })
          : buildEvent("machine.start_failed", { ...envelope, payload: { reason } }),
      ]);
      return;
    }

    yield* dbTry("recording new state", () =>
      db
        .update(machines)
        .set({ state: input.action === "stop" ? "stopped" : "running", lastError: null })
        .where(eq(machines.id, input.machineId)),
    );
    yield* eventBus.publish([
      input.action === "stop"
        ? buildEvent("machine.stopped", { ...envelope, payload: { initiator: "user" } })
        : buildEvent("machine.started", { ...envelope, payload: {} }),
    ]);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError(
        `machine ${input.machineId}: ${input.action} bookkeeping failed: ${String(error)}`,
      ),
    ),
  );
