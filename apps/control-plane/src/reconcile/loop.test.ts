import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Ref } from "effect";
import type { MachineStatus } from "../services/ProvisioningService";
import { makeFakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { reconcileAllOnce, runReconcileLoop } from "./loop";
import type { DesiredMachineState } from "./types";

const machineA: DesiredMachineState = {
  machineId: "m-a",
  orgId: "org-1",
  provider: "fake",
  region: "eastus",
  sizeSku: "Standard_B2s",
  packages: ["docker"],
  lifecycle: "live",
};

const machineB: DesiredMachineState = {
  machineId: "m-b",
  orgId: "org-1",
  provider: "fake",
  region: "eastus",
  sizeSku: "Standard_B2s",
  packages: [],
  lifecycle: "live",
};

describe("reconcileAllOnce", () => {
  test("reconciles every machine in one pass", async () => {
    const layer = makeFakeProvisioningServiceLive();

    const program = Effect.gen(function* () {
      const results = yield* Ref.make<string[]>([]);
      const errors = yield* Ref.make<string[]>([]);

      yield* reconcileAllOnce({
        listMachines: Effect.succeed([
          { desired: machineA, lastKnown: null },
          { desired: machineB, lastKnown: null },
        ]),
        interval: "1 second",
        onResult: (result) =>
          Ref.update(results, (xs) => [...xs, `${result.machineId}:${result.action.kind}`]),
        onError: (machineId) => Ref.update(errors, (xs) => [...xs, machineId]),
      });

      return { results: yield* Ref.get(results), errors: yield* Ref.get(errors) };
    });

    const { results, errors } = await Effect.runPromise(Effect.provide(program, layer));

    expect(results.sort()).toEqual(["m-a:created", "m-b:created"]);
    expect(errors).toEqual([]);
  });

  test("one machine's failure doesn't block the rest of the pass", async () => {
    const layer = makeFakeProvisioningServiceLive();
    // Desired "live" but last-known "archived" makes reconcile-machine refuse
    // to silently revive it (see reconcile-machine.test.ts) — a convenient,
    // already-covered way to exercise a per-machine failure here.
    const archivedButDesiredLive: MachineStatus = {
      machineId: "m-broken",
      state: "archived",
      externalId: null,
    };

    const program = Effect.gen(function* () {
      const results = yield* Ref.make<string[]>([]);
      const errors = yield* Ref.make<string[]>([]);

      yield* reconcileAllOnce({
        listMachines: Effect.succeed([
          { desired: machineA, lastKnown: null },
          { desired: { ...machineB, machineId: "m-broken" }, lastKnown: archivedButDesiredLive },
        ]),
        interval: "1 second",
        onResult: (result) => Ref.update(results, (xs) => [...xs, result.machineId]),
        onError: (machineId) => Ref.update(errors, (xs) => [...xs, machineId]),
      });

      return { results: yield* Ref.get(results), errors: yield* Ref.get(errors) };
    });

    const { results, errors } = await Effect.runPromise(Effect.provide(program, layer));

    expect(results).toEqual(["m-a"]);
    expect(errors).toEqual(["m-broken"]);
  });
});

describe("runReconcileLoop", () => {
  test("repeats reconcile passes on the given interval until interrupted", async () => {
    const layer = makeFakeProvisioningServiceLive();

    const program = Effect.gen(function* () {
      const passes = yield* Ref.make(0);

      const loop = runReconcileLoop({
        listMachines: Ref.update(passes, (n) => n + 1).pipe(
          Effect.as([{ desired: machineA, lastKnown: null }]),
        ),
        interval: "5 millis",
      });

      const fiber = yield* Effect.fork(loop);
      yield* Effect.sleep("60 millis");
      yield* Fiber.interrupt(fiber);

      return yield* Ref.get(passes);
    });

    const passCount = await Effect.runPromise(Effect.provide(program, layer));

    // At >10x the interval, several passes must have run — this is the
    // "it's an actually-repeating Schedule" assertion, not a precise count.
    expect(passCount).toBeGreaterThanOrEqual(2);
  });
});
