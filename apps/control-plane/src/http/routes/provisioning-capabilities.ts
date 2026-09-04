import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * What this *deployment* can technically run — not what an org has chosen
 * to enable (that's `GET /api/v1/integrations`, `kind: "cloud"` rows).
 * Azure is available iff this control-plane booted with
 * `AZURE_SUBSCRIPTION_ID` (+ resource group/subnet) configured; docker/fake
 * always are (see `config.ts`'s `azureSubscriptionId` doc comment and
 * `ProvisioningService.switchable.ts`). Read-only, unauthenticated (no
 * secret in this response — just which knobs exist), so the Integrations
 * page can grey out "Enable" for a provider this deployment can't actually
 * run before the user tries and gets a 500 from the adapter itself.
 */
const AzureCapability = Schema.Struct({
  available: Schema.Boolean,
  subscriptionId: Schema.NullOr(Schema.String),
  resourceGroup: Schema.NullOr(Schema.String),
});

const ProvisioningCapabilitiesResponse = Schema.Struct({
  azure: AzureCapability,
  docker: Schema.Struct({ available: Schema.Boolean }),
  fake: Schema.Struct({ available: Schema.Boolean }),
});

export const ProvisioningCapabilitiesGroup = HttpApiGroup.make("provisioningCapabilities").add(
  HttpApiEndpoint.get("get", "/api/v1/provisioning/capabilities").addSuccess(
    ProvisioningCapabilitiesResponse,
  ),
);
