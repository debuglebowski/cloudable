import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ElevationRepoLive } from "./domain/elevation/ElevationRepo.live";
import { ElevationService } from "./domain/elevation/ElevationService";
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
    // `Layer.mergeAll` does not let sibling entries satisfy each other's
    // requirements — only the trailing `.pipe(Layer.provide(...))` below
    // does that, and only for `AppConfigLive`/`DbLive`. ElevationService
    // depends on EventBus, ApprovalService, and its own ElevationRepoLive
    // (Postgres-backed persistence) too, so it provides them to itself
    // here; Effect's layer memoization means this reuses the same
    // `EventBus`/`ApprovalService` instances built for the bare entries
    // above, rather than constructing separate ones.
    ElevationService.Default.pipe(
      Layer.provide(EventBus.Default),
      Layer.provide(ApprovalService.Default),
      Layer.provide(ElevationRepoLive),
    ),
    adapters.provisioning,
    adapters.signer,
    adapters.secrets,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries. If your service depends on another service already
    // in this list, `.pipe(Layer.provide(<thatService>.Default))` it like ElevationService does above.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
