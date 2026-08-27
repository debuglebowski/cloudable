import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { FakeProvisioningServiceLive } from "./ProvisioningService.fake";
import { ProvisioningServiceTag } from "./ProvisioningService";

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
});
