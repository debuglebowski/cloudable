import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { config } from "../../config";
import {
  ProvisioningAdapterNotOverridableError,
  getCurrentProvisioningAdapter,
  provisioningAdapterOverridable,
  setCurrentProvisioningAdapter,
} from "../../services/ProvisioningService.switchable";
import { Api } from "../api";

const resource = () => ({
  current: getCurrentProvisioningAdapter(),
  bootDefault: config.provisioningAdapter,
  overridable: provisioningAdapterOverridable(),
});

export const DevProvisioningLive = HttpApiBuilder.group(Api, "devProvisioning", (handlers) =>
  handlers
    .handle("get", () => Effect.succeed(resource()))
    .handle("update", ({ payload }) => {
      if (!provisioningAdapterOverridable()) {
        return Effect.fail(
          new ProvisioningAdapterNotOverridableError({
            reason:
              "control-plane booted with PROVISIONING_ADAPTER=azure — cannot switch at runtime",
          }),
        );
      }
      setCurrentProvisioningAdapter(payload.adapter);
      return Effect.succeed(resource());
    }),
);
