import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MachineStatus } from "../services/ProvisioningService";
import { makeFakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { diffUndeclaredPackages, reconcileMachine } from "./reconcile-machine";
import type { DesiredMachineState } from "./types";

const desired = (overrides: Partial<DesiredMachineState> = {}): DesiredMachineState => ({
  machineId: "m-1",
  orgId: "org-1",
  region: "eastus",
  sizeSku: "Standard_B2s",
  packages: ["docker", "nodejs 20"],
  lifecycle: "live",
  ...overrides,
});

describe("diffUndeclaredPackages", () => {
  test("reports only what's reported but not declared", () => {
    expect(diffUndeclaredPackages(["docker"], ["docker", "curl"])).toEqual(["curl"]);
  });

  test("never reports declared-but-missing packages", () => {
    // A package the manifest declares but that isn't running at all is not
    // "drift" in the sense this function cares about — reconcile never
    // installs, so there's nothing to say about it here.
    expect(diffUndeclaredPackages(["docker", "nodejs 20"], [])).toEqual([]);
  });

  test("in sync when reported equals declared", () => {
    expect(diffUndeclaredPackages(["docker", "nodejs 20"], ["docker", "nodejs 20"])).toEqual([]);
  });
});

describe("reconcileMachine", () => {
  test("no last-known status -> create -> provisioning -> running", async () => {
    const program = Effect.gen(function* () {
      const result = yield* reconcileMachine(desired(), null);
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

    const program = reconcileMachine(desired(), null).pipe(
      Effect.flatMap(() => reconcileMachine(desired({ lifecycle: "archived" }), lastKnown)),
    );

    const result = await Effect.runPromise(Effect.provide(program, layer));

    expect(result.action.kind).toBe("archived");
    if (result.action.kind !== "archived") throw new Error("unreachable");
    expect(result.action.status.state).toBe("archived");
  });

  test("desired archived, no last-known status -> no-op, nothing called", async () => {
    const program = reconcileMachine(desired({ lifecycle: "archived" }), null);
    const result = await Effect.runPromise(
      Effect.provide(program, makeFakeProvisioningServiceLive()),
    );

    expect(result.action.kind).toBe("already_archived");
  });

  test("reconcile when in sync is a no-op report", async () => {
    const layer = makeFakeProvisioningServiceLive();

    const program = Effect.gen(function* () {
      const created = yield* reconcileMachine(desired(), null);
      if (created.action.kind !== "created") throw new Error("unreachable");
      return yield* reconcileMachine(desired(), created.action.status);
    });

    const result = await Effect.runPromise(Effect.provide(program, layer));

    expect(result.action.kind).toBe("in_sync");
  });

  test("reconcile when drifted reports undeclared packages but never corrects them", async () => {
    const layer = makeFakeProvisioningServiceLive({
      simulatedExtraPackages: new Map([["m-1", ["unapproved-cli"]]]),
    });

    const program = Effect.gen(function* () {
      const created = yield* reconcileMachine(desired(), null);
      if (created.action.kind !== "created") throw new Error("unreachable");

      const first = yield* reconcileMachine(desired(), created.action.status);
      if (first.action.kind !== "drifted") throw new Error("unreachable");

      // Reconciling again must keep reporting the same drift — nothing was
      // removed by the previous pass; drift is never auto-corrected.
      const second = yield* reconcileMachine(desired(), first.action.status);
      return { first, second };
    });

    const { first, second } = await Effect.runPromise(Effect.provide(program, layer));

    expect(first.action.kind).toBe("drifted");
    expect(second.action.kind).toBe("drifted");
    if (first.action.kind !== "drifted" || second.action.kind !== "drifted")
      throw new Error("unreachable");
    expect(first.action.undeclaredPackages).toEqual(["unapproved-cli"]);
    expect(second.action.undeclaredPackages).toEqual(["unapproved-cli"]);
    // The machine itself was never recreated or archived to "fix" the drift.
    expect(second.action.status.externalId).toBe(first.action.status.externalId);
  });

  test("desired live, last known archived -> fails rather than silently reviving", async () => {
    const lastKnown: MachineStatus = {
      machineId: "m-1",
      state: "archived",
      externalId: "fake-m-1",
    };
    const program = reconcileMachine(desired(), lastKnown);

    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(program, makeFakeProvisioningServiceLive())),
    );

    expect(error._tag).toBe("ReconcileError");
    expect(error.reason).toBe("archived_requires_restore");
  });
});
