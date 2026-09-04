import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { config } from "../config";
import { ProvisioningError, ProvisioningServiceTag } from "./ProvisioningService";
import { AzureProvisioningServiceLive } from "./ProvisioningService.azure";

// Exercises the real Azure ARM SDK against a real subscription — creates,
// reconciles, and archives one real (small) VM. Requires AZURE_SUBSCRIPTION_ID
// and AZURE_MACHINES_SUBNET_ID to already be set in the environment *before*
// `bun test` starts (same convention as PROVISIONING_ADAPTER — config.ts
// reads process.env once at module load, so setting them from inside a test
// file would be too late). Deliberately not run in CI or by default — this
// creates and bills real cloud resources. Run explicitly:
//
//   AZURE_SUBSCRIPTION_ID=... AZURE_MACHINES_RESOURCE_GROUP=... \
//   AZURE_MACHINES_SUBNET_ID=... bun test ProvisioningService.azure.integration-check.ts
const azureConfigured = config.azureSubscriptionId !== null && config.azureMachinesSubnetId !== null;

describe.skipIf(!azureConfigured)(
  "AzureProvisioningService (requires a real Azure subscription)",
  () => {
    const machineId = crypto.randomUUID();

    const run = <A, E>(effect: Effect.Effect<A, E, ProvisioningServiceTag>) =>
      Effect.runPromise(Effect.provide(effect, AzureProvisioningServiceLive));

    afterAll(async () => {
      // Best-effort cleanup regardless of test outcome — archive() tears
      // down every resource create() made (VM, both disks, NIC, public IP).
      await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          yield* provisioning.archive(machineId);
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

      const reconciled = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.reconcile(machineId);
        }),
      );
      expect(["running", "error"]).toContain(reconciled.state);

      const archived = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.archive(machineId);
        }),
      );
      expect(archived.state).toBe("archived");
    }, 600_000);

    test("reconcile on an unknown machine fails with not_found", async () => {
      const result = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* Effect.either(provisioning.reconcile(crypto.randomUUID()));
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
