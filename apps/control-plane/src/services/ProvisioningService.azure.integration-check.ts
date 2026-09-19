import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { config } from "../config";
import { ProvisioningError, ProvisioningServiceTag } from "./ProvisioningService";
import { AzureProvisioningServiceLive } from "./ProvisioningService.azure";

// Exercises the real Azure ARM SDK against a real subscription — creates,
// reconciles, and archives one real (small) VM. Requires AZURE_SUBSCRIPTION_ID
// and AZURE_MACHINES_SUBNET_ID to already be set in the environment *before*
// `bun test` starts — config.ts reads process.env once at module load, so
// setting them from inside a test file would be too late. Deliberately not
// run in CI or by default — this creates and bills real cloud resources.
// Run explicitly:
//
//   AZURE_SUBSCRIPTION_ID=... AZURE_MACHINES_RESOURCE_GROUP=... \
//   AZURE_MACHINES_SUBNET_ID=... bun test ProvisioningService.azure.integration-check.ts
const azureConfigured =
  config.azureSubscriptionId !== null && config.azureMachinesSubnetId !== null;

describe.skipIf(!azureConfigured)(
  "AzureProvisioningService (requires a real Azure subscription)",
  () => {
    const machineId = crypto.randomUUID();

    const run = <A, E>(effect: Effect.Effect<A, E, ProvisioningServiceTag>) =>
      Effect.runPromise(Effect.provide(effect, AzureProvisioningServiceLive));

    afterAll(async () => {
      // Best-effort cleanup regardless of test outcome — archive() tears
      // down every resource create() made (VM, both disks, NIC, public IP).
      // `externalId: null` deliberately — this exercises the real self-heal
      // path (tag-based lookup) live against Azure, not just the direct one.
      await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          yield* provisioning.archive(machineId, "azure", null);
        }),
      ).catch(() => {});
    });

    test("create provisions a real VM; reconcile and archive see the real state", async () => {
      const created = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.create({
            machineId,
            orgId: "integration-check",
            provider: "azure",
            region: "eastus",
            sizeSku: "Standard_B1s",
            image: "ubuntu-22.04",
            packages: [],
          });
        }),
      );
      expect(created.state).toBe("provisioning");
      expect(created.externalId).toContain("/providers/Microsoft.Compute/virtualMachines/");

      // Azure VM creation is asynchronous past the ARM call returning —
      // give the instance view a moment to reflect a real power state
      // before asserting on it.
      await Bun.sleep(15_000);

      // Real created.externalId in hand — exercises resolveVmNames' direct
      // lookup path (no self-heal/tag search needed).
      const reconciled = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.reconcile(machineId, "azure", created.externalId);
        }),
      );
      expect(["running", "error"]).toContain(reconciled.state);
      expect(reconciled.externalId).toBe(created.externalId);

      // Restart needs a VM that is actually up, and Azure takes its time getting there.
      // Polled rather than slept at: a fixed wait either flakes or is always too long.
      let powerState = reconciled.state;
      for (let attempt = 0; attempt < 10 && powerState !== "running"; attempt++) {
        await Bun.sleep(15_000);
        powerState = (
          await run(
            Effect.gen(function* () {
              const provisioning = yield* ProvisioningServiceTag;
              return yield* provisioning.reconcile(machineId, "azure", created.externalId);
            }),
          )
        ).state;
      }
      expect(powerState).toBe("running");

      // The operation azure could not do at all until now — it failed with
      // "not implemented" while the console's Restart button was fully wired.
      const restarted = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.restart(machineId, "azure", created.externalId);
        }),
      );
      expect(restarted.state).toBe("running");
      // Same VM, same identity: a reboot must not mint new infrastructure. If this ever
      // changes the machine's agent would re-attest as something else.
      expect(restarted.externalId).toBe(created.externalId);

      // Capture BEFORE the teardown, the same order `createSnapshot` uses — archive
      // deletes the disks this copies.
      const captured = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.snapshot({
            machineId,
            provider: "azure",
            externalId: created.externalId,
            scope: "full",
            snapshotId: crypto.randomUUID(),
            quiesce: false,
          });
        }),
      );
      const capturedDataDisk = captured.disks.find((disk) => disk.kind === "data");
      expect(capturedDataDisk).toBeDefined();
      // The real provisioned size, not a placeholder — a restore sizes the new disk from it.
      expect(captured.sizeBytes).toBeGreaterThan(0);

      const archived = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.archive(machineId, "azure", reconciled.externalId);
        }),
      );
      expect(archived.state).toBe("archived");

      // The case this whole feature exists for: the machine's VM, both disks, NIC and
      // public IP are gone, and a restore has to rebuild it around the captured data disk.
      // Nothing resolves any more, so this also exercises the adapter probing for what
      // exists rather than being told.
      const restored = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.restoreDataDisk({
            machineId,
            orgId: "integration-check",
            provider: "azure",
            region: "eastus",
            sizeSku: "Standard_B1s",
            image: "ubuntu-22.04",
            externalId: null,
            dataDiskSnapshotId: (capturedDataDisk as { externalId: string }).externalId,
          });
        }),
      );
      expect(restored.state).toBe("provisioning");
      expect(restored.externalId).toContain("/providers/Microsoft.Compute/virtualMachines/");
    }, 900_000);

    test("restoreDataDisk refuses a snapshot id that names nothing, rather than building an empty machine", async () => {
      const result = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* Effect.either(
            provisioning.restoreDataDisk({
              machineId: crypto.randomUUID(),
              orgId: "integration-check",
              provider: "azure",
              region: "eastus",
              sizeSku: "Standard_B1s",
              image: "ubuntu-22.04",
              externalId: null,
              dataDiskSnapshotId: "not-an-arm-resource-id",
            }),
          );
        }),
      );
      // Fails at step 0, before anything is created or destroyed.
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ProvisioningError);
        expect(result.left.reason).toBe("not_found");
      }
    }, 60_000);

    test("restart on an unknown machine fails with not_found, not a false success", async () => {
      const result = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* Effect.either(provisioning.restart(crypto.randomUUID(), "azure", null));
        }),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ProvisioningError);
        expect(result.left.reason).toBe("not_found");
      }
    }, 30_000);

    test("reconcile on an unknown machine fails with not_found", async () => {
      // externalId: null and a machineId nothing was ever tagged with —
      // both resolveVmNames paths (direct lookup, tag self-heal) come up
      // empty, so this also covers the "genuinely nothing exists" outcome.
      const result = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* Effect.either(provisioning.reconcile(crypto.randomUUID(), "azure", null));
        }),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ProvisioningError);
        expect(result.left.reason).toBe("not_found");
      }
    }, 30_000);
  },
);
