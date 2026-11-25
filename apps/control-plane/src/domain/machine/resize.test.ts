import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import {
  events,
  integrations,
  machines,
  orgs,
  people,
  profiles,
  settingValues,
} from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer, ManagedRuntime } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { ApprovalService, settingKeyFor } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import type { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { computeMetricsFrom } from "../../services/ProvisioningService.azure";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { isDbReachable } from "../../testing/db-reachable";
import { MachineService } from "./MachineService";
import { summarizeCompute } from "./compute";
import { applyApprovedResize, requestMachineResize } from "./resize";

describe("compute numbers", () => {
  test("Azure Monitor's answer becomes hourly points and a summary", () => {
    const metrics = computeMetricsFrom({
      value: [
        {
          name: { value: "Percentage CPU" },
          timeseries: [
            {
              data: [
                { timeStamp: "2026-11-25T10:00:00Z", average: 20, maximum: 90 },
                { timeStamp: "2026-11-25T11:00:00Z", average: 40, maximum: 100 },
                { timeStamp: "2026-11-25T12:00:00Z" },
              ],
            },
          ],
        },
        {
          name: { value: "CPU Credits Remaining" },
          timeseries: [
            {
              data: [
                { timeStamp: "2026-11-25T10:00:00Z", minimum: 30, average: 60 },
                { timeStamp: "2026-11-25T11:00:00Z", minimum: 0, average: 0.5 },
                { timeStamp: "2026-11-25T12:00:00Z", minimum: 12 },
              ],
            },
          ],
        },
      ],
    });
    expect(metrics.burstable).toBe(true);
    expect(metrics.points[1]).toEqual({
      at: "2026-11-25T11:00:00Z",
      cpuAverage: 40,
      cpuMax: 100,
      creditsMin: 0,
    });
    expect(summarizeCompute(metrics)).toEqual({
      cpuAverage: 30,
      cpuPeak: 100,
      creditsNow: 12,
      hoursWithoutCredits: 1,
    });
  });

  test("a size without credits reports none", () => {
    const metrics = computeMetricsFrom({
      value: [
        {
          name: { value: "Percentage CPU" },
          timeseries: [{ data: [{ timeStamp: "2026-11-25T10:00:00Z", average: 5, maximum: 9 }] }],
        },
        { name: { value: "CPU Credits Remaining" }, timeseries: [{ data: [] }] },
      ],
    });
    expect(metrics.burstable).toBe(false);
    expect(summarizeCompute(metrics)).toMatchObject({
      creditsNow: null,
      hoursWithoutCredits: null,
    });
  });
});

const reachable = await isDbReachable(config.databaseUrl);

describe.skipIf(!reachable)("resize (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  type Env = Db | EventBus | ApprovalService | MachineService;
  let layer: Layer.Layer<Env | ProvisioningServiceTag>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    // One fake provider, shared: the machine MachineService creates is the one resize finds.
    layer = Layer.mergeAll(
      EventBus.Default.pipe(Layer.provide(dbLayer)),
      ApprovalService.Default,
      MachineService.Default,
      dbLayer,
    ).pipe(Layer.provideMerge(FakeProvisioningServiceLive), Layer.provide(dbLayer));
    runtime = ManagedRuntime.make(layer);
  });
  afterAll(async () => {
    await runtime?.dispose();
    await sql.end();
  });

  // One runtime for the whole suite: the fake provider keeps its machines between calls.
  let runtime: ManagedRuntime.ManagedRuntime<Env | ProvisioningServiceTag, never>;
  const run = <A, E>(effect: Effect.Effect<A, E, Env | ProvisioningServiceTag>) =>
    runtime.runPromise(effect);
  const fail = <A, E>(effect: Effect.Effect<A, E, Env | ProvisioningServiceTag>) =>
    runtime.runPromise(Effect.flip(effect));

  async function seed(mode: "none" | "single") {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("org");
    await db
      .insert(integrations)
      .values({ orgId: org.id, kind: "cloud", provider: "fake", identifier: "fake" });
    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: org.id,
      key: settingKeyFor("machine_resize"),
      value: mode,
      source: "org",
    });
    const [person] = await db
      .insert(people)
      .values({ orgId: org.id, email: `p-${crypto.randomUUID()}@example.com` })
      .returning();
    if (!person) throw new Error("person");
    return { org, person };
  }

  const eventsFor = async (machineId: string) =>
    db.select().from(events).where(eq(events.machineId, machineId));

  /** The resize runs in the background; wait for its outcome to be recorded. */
  const outcome = async (machineId: string) => {
    for (let i = 0; i < 100; i++) {
      const rows = (await eventsFor(machineId)).filter((e) =>
        ["machine.resized", "machine.resize_failed"].includes(e.type),
      );
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return [];
  };

  test("with the mode at none, the machine takes the new size and it is recorded", async () => {
    const { org, person } = await seed("none");
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
    const asked = await run(
      requestMachineResize({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        sizeSku: "large",
        reason: "builds are slow",
      }),
    );
    expect(asked.status).toBe("approved");
    const recorded = await outcome(machine.id);
    expect(recorded.map((e) => [e.type, e.payload])).toEqual([
      ["machine.resized", { fromSize: "small", toSize: "large", approvalId: asked.approvalId }],
    ]);
    const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(row?.sizeSku).toBe("large");
  });

  test("an unlocked profile size is a starting value: the machine may resize away from it", async () => {
    const { org, person } = await seed("none");
    const [profile] = await db
      .insert(profiles)
      .values({
        orgId: org.id,
        name: `p-${crypto.randomUUID()}`,
        provider: "fake",
        sizeSku: "small",
      })
      .returning();
    const machine = await run(
      Effect.flatMap(MachineService, (svc) =>
        svc.create({
          orgId: org.id,
          ownerPersonId: person.id,
          profileId: profile?.id ?? null,
          image: "ubuntu-24.04",
        }),
      ),
    );
    expect(machine.sizeSku).toBe("small");
    const asked = await run(
      requestMachineResize({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        sizeSku: "large",
        reason: "builds are slow",
      }),
    );
    expect(asked.status).toBe("approved");
    expect((await outcome(machine.id)).map((e) => e.type)).toEqual(["machine.resized"]);
  });

  test("it waits for its approval, and a provider failure keeps the old size", async () => {
    const { org, person } = await seed("single");
    // Inserted directly, so the fake provider does not know it: the resize fails there.
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        ownerPersonId: person.id,
        name: "m",
        provider: "fake",
        sizeSku: "small",
        image: "ubuntu-24.04",
        state: "running",
      })
      .returning();
    if (!machine) throw new Error("machine");
    const asked = await run(
      requestMachineResize({
        machineId: machine.id,
        orgId: org.id,
        personId: person.id,
        sizeSku: "large",
        reason: "x",
      }),
    );
    expect(asked.status).toBe("pending");
    expect(await outcome(machine.id)).toEqual([]);

    await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const decided = yield* approvals.decide(
          asked.approvalId,
          org.id,
          crypto.randomUUID(),
          "approved",
          "ok",
        );
        yield* applyApprovedResize(decided);
      }),
    );
    const recorded = await outcome(machine.id);
    expect(recorded.map((e) => e.type)).toEqual(["machine.resize_failed"]);
    const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(row?.sizeSku).toBe("small");
    expect(row?.lastError).toContain("resize to large failed");
  });

  test("refused before anyone is asked: same size, a size the profile locks, no reason", async () => {
    const { org, person } = await seed("single");
    const [profile] = await db
      .insert(profiles)
      .values({
        orgId: org.id,
        name: `p-${crypto.randomUUID()}`,
        provider: "fake",
        sizeSku: "small",
        sizeLocked: true,
      })
      .returning();
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        ownerPersonId: person.id,
        name: "m",
        provider: "fake",
        sizeSku: "small",
        image: "ubuntu-24.04",
        state: "running",
        profileId: profile?.id ?? null,
      })
      .returning();
    if (!machine) throw new Error("machine");
    const ask = (sizeSku: string, reason = "x") =>
      fail(
        requestMachineResize({
          machineId: machine.id,
          orgId: org.id,
          personId: person.id,
          sizeSku,
          reason,
        }),
      );
    expect(await ask("small")).toMatchObject({ code: "same_size" });
    expect(await ask("large")).toMatchObject({ code: "size_fixed_by_profile" });
    expect(await ask("large", " ")).toMatchObject({ code: "reason_required" });
    const asked = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "approval.requested")));
    expect(asked).toEqual([]);
  });
});
