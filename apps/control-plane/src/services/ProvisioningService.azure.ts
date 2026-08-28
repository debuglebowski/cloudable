// STUB: no Azure account exists in this build. Every method fails with
// `not_implemented`. A future unit swaps this in behind the same
// `ProvisioningService` port, calling the Azure ARM SDK directly (CLAUDE.md:
// "No Terraform for provisioning machines — direct ARM SDK calls and a
// reconciliation loop.").
import { Effect, Layer } from "effect";
import { ProvisioningError, type ProvisioningService, ProvisioningServiceTag } from "./ProvisioningService";

const notImplemented = Effect.fail(
  new ProvisioningError({
    reason: "provider_error",
    cause: "no Azure account configured in this build",
  }),
);

const service: ProvisioningService = {
  create: () => notImplemented,
  archive: () => notImplemented,
  reconcile: () => notImplemented,
  reimage: () => notImplemented,
};

export const AzureProvisioningServiceLive = Layer.succeed(ProvisioningServiceTag, service);
