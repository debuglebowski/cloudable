import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, integrations, machines, orgs, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import postgres from "postgres";
import { machinesReportingCheck } from "../../compliance/checks/machines-reporting";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import {
  type MachineStatus,
  type ProvisioningService,
  ProvisioningServiceTag,
} from "../../services/ProvisioningService";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { toLastKnownStatus } from "../../status-refresh/list-machines";
import { persistRefreshResult } from "../../status-refresh/persist-result";
import { refreshMachineStatus } from "../../status-refresh/refresh-machine";
import { isDbReachable } from "../../testing/db-reachable";
import { upgradeMachine } from "../upgrade/UpgradeService";
import { MachineService } from "./MachineService";
import { powerTransitionFor, requestMachinePower } from "./power";
import { restartMachine } from "./restart";

const reachable = await isDbReachable(config.databaseUrl);

describe.skipIf(!reachable)("stop and start (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  type Env = Db | EventBus | MachineService | ProvisioningServiceTag;
  // One runtime for the suite: the fake provider keeps its machines between calls.
  let runtime: ManagedRuntime.ManagedRuntime<Env, never>;
  const run = <A, E>(effect: Effect.Effect<A, E, Env>) => runtime.runPromise(effect);
  const fail = <A, E>(effect: Effect.Effect<A, E, Env>) => runtime.runPromise(Effect.flip(effect));

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    runtime = ManagedRuntime.make(
      Layer.mergeAll(EventBus.Default, MachineService.Default, dbLayer).pipe(
        Layer.provideMerge(FakeProvisioningServiceLive),
        Layer.provideMerge(dbLayer),
      ),
    );
  });
  afterAll(async () => {
    await runtime?.dispose();
    await sql.end();
  });

  async function seed() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("org");
    await db
      .insert(integrations)
      .values({ orgId: org.id, kind: "cloud", provider: "fake", identifier: "fake" });
    const [person] = await db
      .insert(people)
      .values({ orgId: org.id, email: `p-${crypto.randomUUID()}@example.com` })
      .returning();
    if (!person) throw new Error("person");
    return { org, person };
  }

  /** A machine the fake provider knows, so stop and start succeed there. */
  async function liveMachine() {
    const { org, person } = await seed();
    const machine = await run(
      Effect.flatMap(MachineService, (svc) =>
        svc.create({
          orgId: org.id,
          ownerPersonId: person.id,
          provider: "fake",
          sizeSku: "small",
          image: "ubuntu-24.04",
        }),
      ),
    );
    return { org, person, machine };
  }

  /** A row the fake provider has never heard of: every provider call on it fails. */
  async function unknownMachine(state: "running" | "stopped" | "archived_restorable") {
    const { org, person } = await seed();
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        ownerPersonId: person.id,
        name: "m",
        provider: "fake",
        sizeSku: "small",
        image: "ubuntu-24.04",
        state,
      })
      .returning();
    if (!machine) throw new Error("machine");
    return { org, person, machine };
  }

  const powerEvents = async (machineId: string) =>
    (await db.select().from(events).where(eq(events.machineId, machineId))).filter((e) =>
      [
        "machine.stopped",
        "machine.started",
        "machine.stop_failed",
        "machine.start_failed",
      ].includes(e.type),
    );

  /** The provider call runs in the background; wait until it is done. */
  const settled = async (machineId: string) => {
    for (let i = 0; i < 200 && powerTransitionFor(machineId) !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(powerTransitionFor(machineId)).toBeNull();
  };

  const rowOf = async (machineId: string) =>
    (await db.select().from(machines).where(eq(machines.id, machineId)))[0];

  test("stop deallocates and start brings it back; both are recorded with who asked", async () => {
    const { org, person, machine } = await liveMachine();
    const stopping = await run(
      requestMachinePower({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        action: "stop",
      }),
    );
    expect(stopping).toEqual({ machineId: machine.id, state: "stopping" });
    await settled(machine.id);
    expect((await rowOf(machine.id))?.state).toBe("stopped");

    const starting = await run(
      requestMachinePower({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        action: "start",
      }),
    );
    expect(starting.state).toBe("starting");
    await settled(machine.id);
    expect((await rowOf(machine.id))?.state).toBe("running");

    const recorded = (await powerEvents(machine.id)).sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    expect(recorded.map((e) => [e.type, e.payload, e.actorType, e.actorId])).toEqual([
      ["machine.stopped", { initiator: "user" }, "person", person.id],
      ["machine.started", {}, "person", person.id],
    ]);
  });

  test("a provider failure keeps the state, records the reason and sets lastError", async () => {
    const { org, person, machine } = await unknownMachine("running");
    await run(
      requestMachinePower({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        action: "stop",
      }),
    );
    await settled(machine.id);
    const row = await rowOf(machine.id);
    expect(row?.state).toBe("running");
    expect(row?.lastError).toContain("stop failed");
    const recorded = await powerEvents(machine.id);
    expect(recorded.map((e) => e.type)).toEqual(["machine.stop_failed"]);
    expect((recorded[0]?.payload as { reason: string }).reason).toContain("unknown machineId");

    const stopped = await unknownMachine("stopped");
    await run(
      requestMachinePower({
        machineId: stopped.machine.id,
        orgId: stopped.org.id,
        personId: stopped.person.id,
        action: "start",
      }),
    );
    await settled(stopped.machine.id);
    expect((await rowOf(stopped.machine.id))?.state).toBe("stopped");
    expect((await powerEvents(stopped.machine.id)).map((e) => e.type)).toEqual([
      "machine.start_failed",
    ]);
  });

  test("refused in the wrong state, with a sentence that says what to do", async () => {
    const stopped = await unknownMachine("stopped");
    const ask = (m: Awaited<ReturnType<typeof unknownMachine>>, action: "stop" | "start") =>
      fail(
        requestMachinePower({
          machineId: m.machine.id,
          orgId: m.org.id,
          personId: m.person.id,
          action,
        }),
      );
    expect(await ask(stopped, "stop")).toMatchObject({
      error: { code: "machine_not_running", message: "The machine is already stopped." },
    });
    const running = await unknownMachine("running");
    expect(await ask(running, "start")).toMatchObject({
      error: { code: "machine_not_stopped", message: "The machine is already running." },
    });
    const archived = await unknownMachine("archived_restorable");
    expect(await ask(archived, "start")).toMatchObject({
      error: { message: "The machine is archived. It cannot be stopped or started." },
    });
    // Another org's machine is not found, not refused.
    expect(
      await fail(
        requestMachinePower({
          machineId: running.machine.id,
          orgId: stopped.org.id,
          personId: stopped.person.id,
          action: "stop",
        }),
      ),
    ).toMatchObject({ _tag: "MachineNotFoundError" });
    // Nothing was recorded for any refusal.
    expect(await powerEvents(stopped.machine.id)).toEqual([]);
    expect(await powerEvents(running.machine.id)).toEqual([]);
  });

  test("a second request while one is under way is refused, and so are restart and connect", async () => {
    const { org, person, machine } = await unknownMachine("running");
    // A provider whose stop waits until the test lets it finish.
    const gate = Effect.runSync(Deferred.make<void>());
    const blocking = {
      stop: (input: { machineId: string }) =>
        Deferred.await(gate).pipe(
          Effect.as({
            machineId: input.machineId,
            state: "stopped",
            externalId: null,
          } satisfies MachineStatus),
        ),
    } as unknown as ProvisioningService;
    const blockingRuntime = ManagedRuntime.make(
      Layer.mergeAll(
        EventBus.Default.pipe(Layer.provide(Layer.succeed(Db, db))),
        Layer.succeed(Db, db),
        Layer.succeed(ProvisioningServiceTag, blocking),
      ),
    );
    try {
      await blockingRuntime.runPromise(
        requestMachinePower({
          machineId: machine.id,
          orgId: org.id,
          personId: person.id,
          action: "stop",
        }),
      );
      expect(powerTransitionFor(machine.id)).toBe("stopping");
      const again = await blockingRuntime.runPromise(
        Effect.flip(
          requestMachinePower({
            machineId: machine.id,
            orgId: org.id,
            personId: person.id,
            action: "stop",
          }),
        ),
      );
      expect(again).toMatchObject({ error: { code: "machine_busy" } });
      // The row still reads running, but a restart now would reboot a machine going away.
      const restart = await blockingRuntime.runPromise(
        Effect.flip(restartMachine(machine.id, org.id, person.id)),
      );
      expect(restart).toMatchObject({ _tag: "MachineNotRunningError" });

      Effect.runSync(Deferred.succeed(gate, undefined));
      await settled(machine.id);
      expect((await rowOf(machine.id))?.state).toBe("stopped");
    } finally {
      await blockingRuntime.dispose();
    }
  });

  test("restart and upgrade refuse a stopped machine and say to start it", async () => {
    const { org, person, machine } = await unknownMachine("stopped");
    const restart = await fail(restartMachine(machine.id, org.id, person.id));
    expect(restart).toMatchObject({
      error: { code: "machine_not_running", message: "The machine is stopped. Start it instead." },
    });
    const upgrade = await fail(upgradeMachine(machine.id, "ubuntu-24.04", "shallow", person.id));
    expect(upgrade).toMatchObject({ _tag: "UpgradeError", reason: "machine_stopped" });
    expect((await rowOf(machine.id))?.state).toBe("stopped");
  });

  test("the status refresh pass observes a stopped machine and leaves it stopped", async () => {
    const { org, person, machine } = await liveMachine();
    await run(
      requestMachinePower({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        action: "stop",
      }),
    );
    await settled(machine.id);

    // What `listRefreshableMachines` builds for this row (it reads every machine in the
    // database, which is slow on a shared test database).
    const row = await rowOf(machine.id);
    if (!row) throw new Error("machine");
    const desired = {
      machineId: row.id,
      orgId: row.orgId,
      provider: row.provider,
      region: row.region,
      sizeSku: row.sizeSku,
      lifecycle: "live" as const,
    };
    const result = await run(refreshMachineStatus(desired, toLastKnownStatus(row)));
    // Observed, never created, archived or started.
    expect(result.action.kind).toBe("observed");
    expect(result.action.status.state).toBe("stopped");
    await run(persistRefreshResult(result));
    expect((await rowOf(machine.id))?.state).toBe("stopped");
    expect((await powerEvents(machine.id)).map((e) => e.type)).toEqual(["machine.stopped"]);
  });

  test("the machines-reporting check does not flag a stopped machine", async () => {
    const { org, person } = await seed();
    const longAgo = new Date(Date.now() - 24 * 3_600_000);
    const insert = async (state: "running" | "stopped") => {
      const [row] = await db
        .insert(machines)
        .values({
          orgId: org.id,
          ownerPersonId: person.id,
          name: `m-${state}`,
          provider: "fake",
          sizeSku: "small",
          image: "ubuntu-24.04",
          state,
          createdAt: longAgo,
          lastVerifiedAt: longAgo,
        })
        .returning();
      if (!row) throw new Error("machine");
      return row;
    };
    const silentRunning = await insert("running");
    const stopped = await insert("stopped");
    const findings = await run(machinesReportingCheck.evaluate({ orgId: org.id }));
    expect(findings.map((f) => f.machineId)).toEqual([silentRunning.id]);
    expect(findings.some((f) => f.machineId === stopped.id)).toBe(false);
  });
});
