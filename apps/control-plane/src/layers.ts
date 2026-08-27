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
    // Unit 18 (upgrade transactionality): `domain/upgrade/UpgradeService.ts`
    // is plain functions (per the shared "Effect.Service/plain functions"
    // convention), not a wrapping service, so it needs `Db` itself in its
    // handler's context, not just through a service that holds one
    // internally. Exposing `DbLive` here too is safe — Effect memoizes
    // layers by reference, so this shares the same connection as the
    // `DbLive` below rather than opening a second pool.
    DbLive,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
