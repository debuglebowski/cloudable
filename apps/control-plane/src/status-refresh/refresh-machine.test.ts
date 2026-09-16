import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  type MachineStatus,
  type ProvisioningService,
  ProvisioningServiceTag,
} from "../services/ProvisioningService";
import { makeFakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { refreshMachineStatus } from "./refresh-machine";
import type { DesiredMachineState } from "./types";

const desired = (overrides: Partial<DesiredMachineState> = {}): DesiredMachineState => ({
  machineId: "m-1",
  orgId: "org-1",
  provider: "fake",
  region: "eastus",
  sizeSku: "Standard_B2s",
  lifecycle: "live",
  ...overrides,
});

describe("refreshMachineStatus", () => {
  test("no last-known status -> create -> provisioning -> running", async () => {
    const program = Effect.gen(function* () {
      const result = yield* refreshMachineStatus(desired(), null);
      return result;
    });

    const result = await Effect.runPromise(
      Effect.provide(program, makeFakeProvisioningServiceLive()),
    );

    expect(result.action.kind).toBe("created");
    if (result.action.kind !== "created") throw new Error("unreachable");
    expect(result.action.status.state).toBe("running");
    expect(result.action.status.externalId).toBe("fake-m-1");
  });

  test("desired archived, last known running -> archive -> archived", async () => {
    const layer = makeFakeProvisioningServiceLive();
    const lastKnown: MachineStatus = { machineId: "m-1", state: "running", externalId: "fake-m-1" };

    const program = refreshMachineStatus(desired(), null).pipe(
      Effect.flatMap(() => refreshMachineStatus(desired({ lifecycle: "archived" }), lastKnown)),
    );

    const result = await Effect.runPromise(Effect.provide(program, layer));

    expect(result.action.kind).toBe("archived");
    if (result.action.kind !== "archived") throw new Error("unreachable");
    expect(result.action.status.state).toBe("archived");
  });

  test("desired archived, no last-known status -> no-op, nothing called", async () => {
    const program = refreshMachineStatus(desired({ lifecycle: "archived" }), null);
    const result = await Effect.runPromise(
      Effect.provide(program, makeFakeProvisioningServiceLive()),
    );

    expect(result.action.kind).toBe("already_archived");
  });

  test("reconcile when in sync is a no-op report", async () => {
    const layer = makeFakeProvisioningServiceLive();

    const program = Effect.gen(function* () {
      const created = yield* refreshMachineStatus(desired(), null);
      if (created.action.kind !== "created") throw new Error("unreachable");
      return yield* refreshMachineStatus(desired(), created.action.status);
    });

    const result = await Effect.runPromise(Effect.provide(program, layer));

    expect(result.action.kind).toBe("observed");
  });

  test("desired live, last known archived -> fails rather than silently reviving", async () => {
    const lastKnown: MachineStatus = {
      machineId: "m-1",
      state: "archived",
      externalId: "fake-m-1",
    };
    const program = refreshMachineStatus(desired(), lastKnown);

    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(program, makeFakeProvisioningServiceLive())),
    );

    expect(error._tag).toBe("StatusRefreshError");
    expect(error.reason).toBe("archived_requires_restore");
  });

  // Regression: `reconcile()`/`archive()` were called with no third argument
  // at all, so the azure adapter always fell back to guessing a resource
  // name instead of looking up the machine's real, stored one — silently
  // breaking the reconcile loop for every named Azure machine. This spies on
  // the exact arguments `refreshMachineStatus` passes, independent of what any
  // particular adapter does with them.
  describe("threads `lastKnown.externalId` through to the provisioning port", () => {
    function spyProvisioning() {
      const calls: Array<{ method: string; machineId: string; externalId: string | null }> = [];
      const provisioning: ProvisioningService = {
        snapshot: () => Effect.die("not used in this test"),
        create: () => Effect.die("not used in this test"),
        // Not exercised here — inspection has its own tests. `die` rather than a stub
        // result so an unexpected call fails loudly instead of passing silently.
        grantSnapshotRead: () => Effect.die("grantSnapshotRead not stubbed in this test"),
        revokeSnapshotRead: () => Effect.die("revokeSnapshotRead not stubbed in this test"),
        archive: (machineId, _provider, externalId) => {
          calls.push({ method: "archive", machineId, externalId });
          return Effect.succeed({ machineId, state: "archived", externalId });
        },
        reconcile: (machineId, _provider, externalId) => {
          calls.push({ method: "reconcile", machineId, externalId });
          return Effect.succeed({ machineId, state: "running", externalId });
        },
        reimage: () => Effect.die("not used in this test"),
        restart: () => Effect.die("not used in this test"),
      };
      return { calls, layer: Layer.succeed(ProvisioningServiceTag, provisioning) };
    }

    test("reconcile", async () => {
      const { calls, layer } = spyProvisioning();
      const lastKnown: MachineStatus = {
        machineId: "m-1",
        state: "running",
        externalId: "real-id",
      };

      await Effect.runPromise(Effect.provide(refreshMachineStatus(desired(), lastKnown), layer));

      expect(calls).toEqual([{ method: "reconcile", machineId: "m-1", externalId: "real-id" }]);
    });

    test("archive", async () => {
      const { calls, layer } = spyProvisioning();
      const lastKnown: MachineStatus = {
        machineId: "m-1",
        state: "running",
        externalId: "real-id",
      };

      await Effect.runPromise(
        Effect.provide(refreshMachineStatus(desired({ lifecycle: "archived" }), lastKnown), layer),
      );

      expect(calls).toEqual([{ method: "archive", machineId: "m-1", externalId: "real-id" }]);
    });
  });
});
