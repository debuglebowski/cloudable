import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ProvisioningServiceTag } from "./ProvisioningService";
import {
  FAKE_VERIFICATION_FAILURE_IMAGE,
  FakeProvisioningServiceLive,
  makeFakeProvisioningServiceLive,
} from "./ProvisioningService.fake";

describe("ProvisioningService.fake", () => {
  test("create -> running, archive -> archived, reconcile reports current status", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;

      const created = yield* provisioning.create({
        machineId: "m-1",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });
      expect(created.state).toBe("running");
      expect(created.externalId).toBe("fake-m-1");

      const reconciledBeforeArchive = yield* provisioning.reconcile("m-1");
      expect(reconciledBeforeArchive).toEqual(created);

      const archived = yield* provisioning.archive("m-1");
      expect(archived.state).toBe("archived");
      expect(archived.externalId).toBe("fake-m-1");

      const reconciledAfterArchive = yield* provisioning.reconcile("m-1");
      expect(reconciledAfterArchive).toEqual(archived);
    });

    await Effect.runPromise(Effect.provide(program, FakeProvisioningServiceLive));
  });

  test("archive and reconcile fail with not_found for an unknown machine", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      const archiveError = yield* Effect.flip(provisioning.archive("does-not-exist"));
      const reconcileError = yield* Effect.flip(provisioning.reconcile("does-not-exist"));
      return { archiveError, reconcileError };
    });

    const { archiveError, reconcileError } = await Effect.runPromise(
      Effect.provide(program, FakeProvisioningServiceLive),
    );
    expect(archiveError.reason).toBe("not_found");
    expect(reconcileError.reason).toBe("not_found");
  });

  test("reconcile reports declared packages plus configured simulated extras, never fewer or more", async () => {
    const layer = makeFakeProvisioningServiceLive({
      simulatedExtraPackages: new Map([["m-1", ["unapproved-cli"]]]),
    });

    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      const created = yield* provisioning.create({
        machineId: "m-1",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
        packages: ["docker"],
      });
      const reconciled = yield* provisioning.reconcile("m-1");
      return { created, reconciled };
    });

    const { created, reconciled } = await Effect.runPromise(Effect.provide(program, layer));

    expect(created.reportedPackages).toEqual(["docker", "unapproved-cli"]);
    expect(reconciled.reportedPackages).toEqual(["docker", "unapproved-cli"]);
  });

  test("with no simulated extras configured, reconcile reports exactly the declared packages", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      yield* provisioning.create({
        machineId: "m-2",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
        packages: ["docker", "nodejs 20"],
      });
      return yield* provisioning.reconcile("m-2");
    });

    const reconciled = await Effect.runPromise(
      Effect.provide(program, FakeProvisioningServiceLive),
    );
    expect(reconciled.reportedPackages).toEqual(["docker", "nodejs 20"]);
  });

  test("reimage -> running, reconcile then reports running (verification success)", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      yield* provisioning.create({
        machineId: "m-reimage-1",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });

      const reimaged = yield* provisioning.reimage({
        machineId: "m-reimage-1",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
        targetImage: "ubuntu-24.04",
      });
      expect(reimaged.state).toBe("running");

      const reconciled = yield* provisioning.reconcile("m-reimage-1");
      expect(reconciled.state).toBe("running");
    });

    await Effect.runPromise(Effect.provide(program, FakeProvisioningServiceLive));
  });

  test("reimage to the sentinel image lands in error state, so reconcile reports verification failure", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      yield* provisioning.create({
        machineId: "m-reimage-2",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });

      const reimaged = yield* provisioning.reimage({
        machineId: "m-reimage-2",
        orgId: "org-1",
        region: "eastus",
        sizeSku: "Standard_B2s",
        targetImage: FAKE_VERIFICATION_FAILURE_IMAGE,
      });
      expect(reimaged.state).toBe("error");

      const reconciled = yield* provisioning.reconcile("m-reimage-2");
      expect(reconciled.state).toBe("error");
    });

    await Effect.runPromise(Effect.provide(program, FakeProvisioningServiceLive));
  });

  test("reimage fails with not_found for an unknown machine", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      return yield* Effect.flip(
        provisioning.reimage({
          machineId: "does-not-exist",
          orgId: "org-1",
          region: "eastus",
          sizeSku: "Standard_B2s",
          targetImage: "ubuntu-24.04",
        }),
      );
    });

    const error = await Effect.runPromise(Effect.provide(program, FakeProvisioningServiceLive));
    expect(error.reason).toBe("not_found");
  });
});
