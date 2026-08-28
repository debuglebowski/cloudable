import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ElevationRepoLive } from "./domain/elevation/ElevationRepo.live";
import { ElevationService } from "./domain/elevation/ElevationService";
import { MachineService } from "./domain/machine/MachineService";
import { OffboardingLive } from "./domain/offboarding";
import { ApprovalService } from "./services/ApprovalService";
import { AttestationRegistryLive } from "./services/attestation/registry";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";
import { AgentSessionToken } from "./services/attestation/AgentSessionToken";
import { MachineDirectory } from "./services/attestation/MachineDirectory";
import { FederationService } from "./services/federation/FederationService";

/**
 * `attestation` is deliberately NOT one of the swappable `adapters` below,
 * unlike `provisioning`/`signer`/`secrets` (each of which has a fake-vs-real
 * split for local dev/test). Both `AttestationMethod`s (join-token,
 * managed-identity) are genuinely real implementations already — neither
 * calls out to a credentialed Azure resource on our side, so there's no
 * fake/local variant to swap in — and `/attest` must be able to dispatch to
 * EITHER one concurrently by the request's own `method` field, which is
 * exactly what `AttestationRegistryLive` (see `services/attestation/registry.ts`)
 * provides. Always wired in, for every deployment.
 */
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
    MachineService.Default,
    AgentSessionToken.Default,
    MachineDirectory.Default,
    // OffboardingLive's MachineArchiver delegates to the real archiveMachine,
    // which needs ProvisioningServiceTag — not a fixed `.Default` sibling
    // like EventBus, but the caller-chosen adapter, so it's provided
    // explicitly here rather than relying on mergeAll's flat union (see the
    // note below on why that doesn't resolve cross-layer dependencies).
    OffboardingLive.pipe(Layer.provide(adapters.provisioning)),
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
    AttestationRegistryLive,
    // Unit 18 (upgrade transactionality) and unit 19 (config editor):
    // `domain/upgrade/UpgradeService.ts` and the config feature's
    // `ConfigLive` are plain functions/handlers (per the shared
    // "Effect.Service/plain functions" convention), not wrapping services,
    // so they need `Db` itself in their handler's context, not just through
    // a service that holds one internally. Exposing `DbLive` here too is
    // safe — Effect memoizes layers by reference, so this shares the same
    // connection as the `DbLive` below (and `server.ts`'s own
    // `Layer.provide(DbLive)` on `ApiLive`) rather than opening a second pool.
    DbLive,
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
    // Note: `Layer.mergeAll` does not wire sibling layers' dependencies into
    // each other — it's a flat union, not a dependency graph (verified: a
    // service depending on another `Effect.Service` sibling here fails at
    // runtime with "Service not found: <Tag>" unless wired explicitly). If
    // your service depends on another `Effect.Service` (e.g. `EventBus`),
    // provide it explicitly: `YourService.Default.pipe(Layer.provide(TheDependency.Default))`
    // — `Layer.provide`'s outer `DbLive` below still only has to appear once,
    // thanks to Effect's default layer memoization.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
