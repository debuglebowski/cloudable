import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { config } from "../../config";
import { Api } from "../api";

export const ProvisioningCapabilitiesLive = HttpApiBuilder.group(
  Api,
  "provisioningCapabilities",
  (handlers) =>
    handlers.handle("get", () =>
      Effect.succeed({
        azure: {
          available: config.azureSubscriptionId !== null,
          subscriptionId: config.azureSubscriptionId,
          resourceGroup: config.azureSubscriptionId ? config.azureMachinesResourceGroup : null,
        },
        docker: { available: true },
        fake: { available: true },
      }),
    ),
);
