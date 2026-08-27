import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ApprovalService } from "./services/ApprovalService";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";

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
    // Exposed at the top level too (not just provided internally below) so
    // that HTTP handler layers needing `Db` directly (e.g. the config
    // feature unit's `ConfigLive`) get it from this same graph rather than
    // opening a second connection — Effect memoizes `DbLive` by reference,
    // so this and the internal `Layer.provide` below share one connection.
    DbLive,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
