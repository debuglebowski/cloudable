import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { events, machines, orgs, upgradeAttempts } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import {
  FAKE_VERIFICATION_FAILURE_IMAGE,
  FakeProvisioningServiceLive,
} from "../../services/ProvisioningService.fake";
import { isEligibleForUpgrade, upgradeMachine } from "./UpgradeService";
import { UpgradeError } from "./types";

// NOTE: `testcontainers-node`'s `.start()` promise never resolves under Bun
// in some sandboxes (Docker starts the container fine at the daemon level;
// the JS side just never sees it) — see oven-sh/bun#21342 and
// testcontainers-node#974. If `beforeAll` below times out or hangs in your
// environment, that's this upstream issue, not a bug in `UpgradeService`.
// This suite was additionally verified by hand against the real
// docker-compose Postgres (`DATABASE_URL` pointed at port 5442) — see the PR
// description for the exact commands.
describe("UpgradeService", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  const runtimes: Array<ManagedRuntime.ManagedRuntime<never, never>> = [];

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await Promise.all(runtimes.map((r) => r.dispose()));
    await testDb.stop();
  });

  /**
   * Fresh org + running machine, plus a `ManagedRuntime` over the layer
   * graph. `FakeProvisioningServiceLive` holds its state in a `Ref` that
   * lives for as long as the layer instance is running — a fresh
   * `Effect.provide(...)` per call would rebuild it from scratch each time
   * and "forget" the machine, so every call for one test must share the
   * SAME runtime (that's what `ManagedRuntime` is for).
   */
  const setUpMachine = async (initialImage = "ubuntu-22.04") => {
    const [org] = await testDb.db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    const [machine] = await testDb.db
      .insert(machines)
      .values({
        orgId: org!.id,
        name: "test-machine",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: initialImage,
        state: "running",
      })
      .returning();

    const DbTestLive = Layer.succeed(Db, testDb.db);
    const layer = Layer.mergeAll(DbTestLive, EventBus.Default, FakeProvisioningServiceLive).pipe(
      Layer.provide(DbTestLive),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.push(runtime);

    // Seed the fake provisioning service so it already knows this machine —
    // mirroring a machine that was created (and is running) before this
    // upgrade attempt.
    await runtime.runPromise(
      Effect.gen(function* () {
        const provisioning = yield* ProvisioningServiceTag;
        yield* provisioning.create({
          machineId: machine!.id,
          orgId: org!.id,
          region: "eastus",
          sizeSku: "Standard_B2s",
        });
      }),
    );

    return { org: org!, machine: machine!, runtime };
  };

  test("success: updates machines.image, emits machine.reimaged, and advances nextEligibleAt", async () => {
    const { machine, runtime } = await setUpMachine();

    const result = await runtime.runPromise(upgradeMachine(machine.id, "ubuntu-24.04"));

    expect(result.outcome).toBe("success");
    expect(result.previousImage).toBe("ubuntu-22.04");
    expect(result.currentImage).toBe("ubuntu-24.04");
    expect(result.snapshotId).not.toBeNull();
    expect(result.driftUrl).toBeUndefined();

    const [updated] = await testDb.db
      .select()
      .from(machines)
      .where(eq(machines.id, machine.id))
      .limit(1);
    expect(updated?.image).toBe("ubuntu-24.04");

    const emitted = await testDb.db.select().from(events).where(eq(events.machineId, machine.id));
    const reimaged = emitted.find((e) => e.type === "machine.reimaged");
    expect(reimaged).toBeDefined();
    expect(reimaged?.payload).toEqual({
      previousImage: "ubuntu-22.04",
      currentImage: "ubuntu-24.04",
    });

    expect(result.nextEligibleAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("failure: verification failure rolls back — image is unchanged, no machine.reimaged, drift link present", async () => {
    const { machine, runtime } = await setUpMachine();

    const result = await runtime.runPromise(
      upgradeMachine(machine.id, FAKE_VERIFICATION_FAILURE_IMAGE),
    );

    expect(result.outcome).toBe("rolled_back");
    expect(result.previousImage).toBe("ubuntu-22.04");
    expect(result.currentImage).toBe("ubuntu-22.04");
    expect(result.restoredSnapshotId).toBe(result.snapshotId ?? undefined);
    expect(result.driftUrl).toBe(`/machines/${machine.id}#drift`);
    expect(result.failureReason).toBeDefined();

    const [updated] = await testDb.db
      .select()
      .from(machines)
      .where(eq(machines.id, machine.id))
      .limit(1);
    expect(updated?.image).toBe("ubuntu-22.04");

    const emitted = await testDb.db.select().from(events).where(eq(events.machineId, machine.id));
    expect(emitted.find((e) => e.type === "machine.reimaged")).toBeUndefined();
  });

  test("both success and failure equally advance nextEligibleAt", async () => {
    const successSetup = await setUpMachine();
    const successResult = await successSetup.runtime.runPromise(
      upgradeMachine(successSetup.machine.id, "ubuntu-24.04"),
    );

    const failureSetup = await setUpMachine();
    const failureResult = await failureSetup.runtime.runPromise(
      upgradeMachine(failureSetup.machine.id, FAKE_VERIFICATION_FAILURE_IMAGE),
    );

    expect(successResult.nextEligibleAt.getTime()).toBeGreaterThan(Date.now());
    expect(failureResult.nextEligibleAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("repeated failures back off further each time (consecutive-failure backoff)", async () => {
    const { machine, runtime } = await setUpMachine();

    // First failing attempt.
    const first = await runtime.runPromise(
      upgradeMachine(machine.id, FAKE_VERIFICATION_FAILURE_IMAGE),
    );

    // Force eligibility open again (bypassing the real clock) so we can
    // observe the SECOND consecutive failure's backoff without waiting.
    await testDb.db
      .update(upgradeAttempts)
      .set({ nextEligibleAt: new Date(Date.now() - 1000) })
      .where(eq(upgradeAttempts.machineId, machine.id));

    const second = await runtime.runPromise(
      upgradeMachine(machine.id, FAKE_VERIFICATION_FAILURE_IMAGE),
    );

    const firstInterval = first.nextEligibleAt.getTime() - Date.now();
    const secondInterval = second.nextEligibleAt.getTime() - Date.now();
    // second interval should be roughly double the first (exponential backoff)
    expect(secondInterval).toBeGreaterThan(firstInterval * 1.5);
  });

  test("isEligibleForUpgrade is true with no history, false right after an attempt", async () => {
    const { machine, runtime } = await setUpMachine();

    const eligibleBefore = await runtime.runPromise(isEligibleForUpgrade(machine.id));
    expect(eligibleBefore).toBe(true);

    await runtime.runPromise(upgradeMachine(machine.id, "ubuntu-24.04"));

    const eligibleAfter = await runtime.runPromise(isEligibleForUpgrade(machine.id));
    expect(eligibleAfter).toBe(false);
  });

  test("calling upgradeMachine again before nextEligibleAt is rejected as not_eligible", async () => {
    const { machine, runtime } = await setUpMachine();

    await runtime.runPromise(upgradeMachine(machine.id, "ubuntu-24.04"));

    const error = await runtime.runPromise(Effect.flip(upgradeMachine(machine.id, "ubuntu-26.04")));
    expect(error).toBeInstanceOf(UpgradeError);
    expect((error as UpgradeError).reason).toBe("not_eligible");
    expect((error as UpgradeError).nextEligibleAt).toBeDefined();
  });

  test("unknown machine fails with machine_not_found", async () => {
    const DbTestLive = Layer.succeed(Db, testDb.db);
    const layer = Layer.mergeAll(DbTestLive, EventBus.Default, FakeProvisioningServiceLive).pipe(
      Layer.provide(DbTestLive),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.push(runtime);

    const error = await runtime.runPromise(
      Effect.flip(upgradeMachine(crypto.randomUUID(), "ubuntu-24.04")),
    );
    expect((error as UpgradeError).reason).toBe("machine_not_found");
  });
});
