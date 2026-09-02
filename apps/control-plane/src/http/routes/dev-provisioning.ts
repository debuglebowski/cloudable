import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { PROVISIONING_ADAPTERS } from "../../config";
import { ProvisioningAdapterNotOverridableError } from "../../services/ProvisioningService.switchable";
import { CurrentUserAuthentication } from "../middleware/auth";

// Dev-only control for which `ProvisioningService` a running control-plane
// dispatches to — see `services/ProvisioningService.switchable.ts`. Never a
// customer-facing endpoint: `update` is rejected (see that file's
// `provisioningAdapterOverridable`) whenever this process booted with
// `PROVISIONING_ADAPTER=azure`, which every real deployment does.

const ProvisioningAdapterLiteral = Schema.Literal(...PROVISIONING_ADAPTERS);

const DevProvisioningAdapterResource = Schema.Struct({
  current: ProvisioningAdapterLiteral,
  bootDefault: ProvisioningAdapterLiteral,
  overridable: Schema.Boolean,
});

const SetDevProvisioningAdapterPayload = Schema.Struct({
  adapter: ProvisioningAdapterLiteral,
});

export const DevProvisioningGroup = HttpApiGroup.make("devProvisioning")
  .add(
    HttpApiEndpoint.get("get", "/api/v1/dev/provisioning-adapter").addSuccess(
      DevProvisioningAdapterResource,
    ),
  )
  .add(
    HttpApiEndpoint.patch("update", "/api/v1/dev/provisioning-adapter")
      .setPayload(SetDevProvisioningAdapterPayload)
      .addSuccess(DevProvisioningAdapterResource)
      .addError(ProvisioningAdapterNotOverridableError, { status: 403 }),
  )
  .middleware(CurrentUserAuthentication);
