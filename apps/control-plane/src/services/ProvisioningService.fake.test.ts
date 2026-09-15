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
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });
      expect(created.state).toBe("running");
      expect(created.externalId).toBe("fake-m-1");

      const reconciledBeforeArchive = yield* provisioning.reconcile("m-1", "fake", null);
      expect(reconciledBeforeArchive).toEqual(created);

      const archived = yield* provisioning.archive("m-1", "fake", null);
      expect(archived.state).toBe("archived");
      expect(archived.externalId).toBe("fake-m-1");

      const reconciledAfterArchive = yield* provisioning.reconcile("m-1", "fake", null);
      expect(reconciledAfterArchive).toEqual(archived);
    });

    await Effect.runPromise(Effect.provide(program, FakeProvisioningServiceLive));
  });

  // ---------------------------------------------------------------------------
  // The snapshot port. It exists because `createSnapshot` used to write a database
  // row and nothing else — no provider call, one hardcoded 32 GiB on every row, and
  // no id to aim a restore or an expiry deletion at. These lock the two properties
  // that matter at the port level; whether Azure honours them is the azure adapter's
  // problem and is not testable here.
  // ---------------------------------------------------------------------------

  test("scope decides which disks are captured, and every capture is named", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      yield* provisioning.create({
        machineId: "m-snap",
        orgId: "org-1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });

      const full = yield* provisioning.snapshot({
        machineId: "m-snap",
        provider: "fake",
        externalId: null,
        scope: "full",
        quiesce: true,
      });
      expect(full.disks.map((disk) => disk.kind)).toEqual(["os", "data"]);

      // "shallow" omits the OS disk deliberately: /home is on the data disk, and the
      // OS is rebuilt from its image. It is a complete copy of the only part that
      // cannot be recreated, not a lesser copy of the same thing.
      const shallow = yield* provisioning.snapshot({
        machineId: "m-snap",
        provider: "fake",
        externalId: null,
        scope: "shallow",
        quiesce: false,
      });
      expect(shallow.disks.map((disk) => disk.kind)).toEqual(["data"]);
      expect(shallow.sizeBytes).toBeLessThan(full.sizeBytes);

      // An id per disk is the whole point of the port. Without one, a snapshot can
      // never be restored from and never deleted when its retention expires — which
      // is exactly the state all six production snapshot rows are in.
      for (const disk of [...full.disks, ...shallow.disks]) {
        expect(disk.externalId).not.toBe("");
        expect(disk.sizeBytes).toBeGreaterThan(0);
      }
      expect(full.sizeBytes).toBe(full.disks.reduce((sum, disk) => sum + disk.sizeBytes, 0));
    });

    await Effect.runPromise(Effect.provide(program, makeFakeProvisioningServiceLive()));
  });

  test("snapshot fails with not_found for an unknown machine", async () => {
    // createSnapshot treats this one reason as "nothing to copy" and records a row
    // with no captured disks, rather than letting a machine whose infrastructure is
    // already gone block its own archive.
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      const result = yield* Effect.either(
        provisioning.snapshot({
          machineId: "missing",
          provider: "fake",
          externalId: null,
          scope: "full",
          quiesce: false,
        }),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.reason).toBe("not_found");
    });

    await Effect.runPromise(Effect.provide(program, makeFakeProvisioningServiceLive()));
  });

  test("archive and reconcile fail with not_found for an unknown machine", async () => {
    const program = Effect.gen(function* () {
      const provisioning = yield* ProvisioningServiceTag;
      const archiveError = yield* Effect.flip(provisioning.archive("does-not-exist", "fake", null));
      const reconcileError = yield* Effect.flip(
        provisioning.reconcile("does-not-exist", "fake", null),
      );
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
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        packages: ["docker"],
      });
      const reconciled = yield* provisioning.reconcile("m-1", "fake", null);
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
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        packages: ["docker", "nodejs 20"],
      });
      return yield* provisioning.reconcile("m-2", "fake", null);
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
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });

      const reimaged = yield* provisioning.reimage({
        machineId: "m-reimage-1",
        orgId: "org-1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        targetImage: "ubuntu-24.04",
        externalId: null,
      });
      expect(reimaged.state).toBe("running");

      const reconciled = yield* provisioning.reconcile("m-reimage-1", "fake", null);
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
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
      });

      const reimaged = yield* provisioning.reimage({
        machineId: "m-reimage-2",
        orgId: "org-1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        targetImage: FAKE_VERIFICATION_FAILURE_IMAGE,
        externalId: null,
      });
      expect(reimaged.state).toBe("error");

      const reconciled = yield* provisioning.reconcile("m-reimage-2", "fake", null);
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
          provider: "fake",
          region: "eastus",
          sizeSku: "Standard_B2s",
          targetImage: "ubuntu-24.04",
          externalId: null,
        }),
      );
    });

    const error = await Effect.runPromise(Effect.provide(program, FakeProvisioningServiceLive));
    expect(error.reason).toBe("not_found");
  });
});
