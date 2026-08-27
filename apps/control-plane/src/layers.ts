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
    // `ApprovalService` writes its `approval.*` events in the same DB
    // transaction as the state change they evidence (see
    // `services/ApprovalService.ts`'s use of `EventBus.ts`'s exported
    // `toEventRows`), so it does not depend on `EventBus` as a context
    // service here — it only imports a plain helper function from it.
    ApprovalService.Default,
    adapters.provisioning,
    adapters.signer,
    adapters.secrets,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
    //
    // Note: `Layer.mergeAll` does not wire sibling layers' dependencies into
    // each other — it's a flat union, not a dependency graph (verified: a
    // service depending on another `Effect.Service` sibling here fails at
    // runtime with "Service not found: <Tag>" unless wired explicitly). If
    // your service depends on another `Effect.Service` (e.g. `EventBus`),
    // provide it explicitly: `YourService.Default.pipe(Layer.provide(TheDependency.Default))`
    // — `Layer.provide`'s outer `DbLive` below still only has to appear once,
    // thanks to Effect's default layer memoization.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
