import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ApprovalService } from "./services/ApprovalService";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";
import { FederationService } from "./services/federation/FederationService";

export const buildAppLive = (adapters: {
  provisioning: Layer.Layer<ProvisioningServiceTag>;
  signer: Layer.Layer<SignerTag>;
  secrets: Layer.Layer<SecretsProviderTag>;
}) =>
  Layer.mergeAll(
    EventBus.Default,
    ApprovalService.Default,
    adapters.provisioning,
    adapters.signer,
    adapters.secrets,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
    //
    // FederationService depends on EventBus and Signer, both siblings in
    // this same list — `Layer.mergeAll` builds siblings independently, so a
    // service needing another sibling's output must wire it explicitly via
    // `Layer.provide` like this (Db/AppConfig are already ambient for the
    // whole list via the `.pipe(Layer.provide(...))` below).
    FederationService.Default.pipe(
      Layer.provide(Layer.mergeAll(EventBus.Default, adapters.signer)),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
