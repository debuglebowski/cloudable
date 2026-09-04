import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ElevationRepoLive } from "./domain/elevation/ElevationRepo.live";
import { ElevationService } from "./domain/elevation/ElevationService";
import { MachineService } from "./domain/machine/MachineService";
import { OffboardingLive } from "./domain/offboarding";
import { CurrentUserAuthenticationLive } from "./http/middleware/auth";
import { ApprovalService } from "./services/ApprovalService";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";
import { AgentSessionToken } from "./services/attestation/AgentSessionToken";
import { MachineDirectory } from "./services/attestation/MachineDirectory";
import { AttestationRegistryLive } from "./services/attestation/registry";
import { SshCaService } from "./services/ssh-ca/SshCaService";
import { TunnelRegistry } from "./tunnel/registry";
import { TunnelRelay } from "./tunnel/relay";
import { TunnelServer } from "./tunnel/server";
import { TunnelSignal } from "./tunnel/signal";

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
}) => {
  const infra = Layer.mergeAll(AppConfigLive, DbLive);
  // EventBus is provided from `infra` up front (rather than left as a flat sibling below) so
  // that SshCaService/TunnelServer — which both depend on it — can be wired against it
  // explicitly: `Layer.mergeAll` does not resolve one merged layer's requirement against
  // another merged layer's output, only against what an enclosing `Layer.provide` supplies.
  //
  // `provideMerge` (not `provide`) here: both services' methods return Effects that read
  // `SignerTag`/`EventBus`/`Db` lazily *when called*, not only while the service's own
  // constructor effect runs — `provide` would satisfy construction but then hide those
  // services from the ambient context a caller later runs the method in, which fails at
  // call time (`Service not found`) despite type-checking cleanly. `provideMerge` keeps
  // them present in the final context alongside `SshCaService`/`TunnelServer` themselves.
  const eventBus = EventBus.Default.pipe(Layer.provide(infra));
  const sshCa = SshCaService.Default.pipe(
    Layer.provideMerge(Layer.mergeAll(eventBus, adapters.signer, infra)),
  );
  // `TunnelServer.mintSession`/`terminateSessionsForMachine` push to `TunnelSignal` (the
  // CP -> agent tunnel-signal channel, tunnel/signal.ts) lazily, the same "called later, not
  // only at layer-build time" shape `EventBus`/`Signer` already have here — see the
  // `provideMerge` comment below. `tunnelSignal` is also exposed standalone in the outer
  // `Layer.mergeAll(...)` further down (same reference, memoized — see `DbLive`'s own note
  // there) so `TunnelSignalLive` (the long-poll HTTP handler) can resolve it too, independent
  // of `TunnelServer`.
  const tunnelSignal = TunnelSignal.Default;
  const tunnel = TunnelServer.Default.pipe(
    Layer.provideMerge(Layer.mergeAll(eventBus, adapters.signer, infra, tunnelSignal)),
  );
  // `TunnelRelay` composes the DB-backed `TunnelServer` above with the
  // in-process `TunnelRegistry` (live websocket connections) — see
  // `tunnel/relay.ts`'s own doc comment. Built once here (not per-consumer)
  // so `OffboardingLive`'s `DefaultSessionTerminatorLive` below and
  // `ArchiveLive` (server.ts's HTTP layer) share the same registry instance
  // rather than each getting an empty one of their own.
  const tunnelRelay = TunnelRelay.Default.pipe(
    Layer.provideMerge(Layer.mergeAll(tunnel, TunnelRegistry.Default)),
  );

  return Layer.mergeAll(
    eventBus,
    // `ApprovalService` writes its `approval.*` events in the same DB
    // transaction as the state change they evidence (see
    // `services/ApprovalService.ts`'s use of `EventBus.ts`'s exported
    // `toEventRows`), so it does not depend on `EventBus` as a context
    // service here — it only imports a plain helper function from it.
    ApprovalService.Default,
    // MachineService.create now calls ProvisioningServiceTag directly (see
    // that file) — same reasoning as OffboardingLive just below: not a fixed
    // `.Default` sibling like EventBus, but the caller-chosen adapter, so
    // it's provided explicitly rather than relying on mergeAll's flat union.
    MachineService.Default.pipe(Layer.provide(adapters.provisioning)),
    AgentSessionToken.Default,
    MachineDirectory.Default,
    // OffboardingLive's MachineArchiver delegates to the real archiveMachine,
    // which needs ProvisioningServiceTag — not a fixed `.Default` sibling
    // like EventBus, but the caller-chosen adapter, so it's provided
    // explicitly here rather than relying on mergeAll's flat union (see the
    // note below on why that doesn't resolve cross-layer dependencies).
    OffboardingLive.pipe(Layer.provide(adapters.provisioning), Layer.provide(tunnelRelay)),
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
    // Real session auth (see `http/middleware/auth.ts`) — needs `Db` to
    // resolve a BetterAuth session's email to a `people` row, ambient below
    // via `infra`.
    CurrentUserAuthenticationLive,
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
    sshCa,
    tunnel,
    // Same reference as the one `tunnel` above provides itself via `provideMerge` — Effect's
    // layer memoization means this shares that single built instance rather than constructing
    // a second one (same note `DbLive` above makes about itself). Exposed standalone here so
    // `TunnelSignalLive` (the tunnel-signal long-poll HTTP handler) can depend on `TunnelSignal`
    // directly, without going through `TunnelServer` at all.
    tunnelSignal,
    // Same reference `OffboardingLive` above is given via `Layer.provide` — exposed
    // standalone too so `ArchiveLive` (server.ts's HTTP layer, not part of this file)
    // can depend on `TunnelRelay` directly.
    tunnelRelay,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
    //
    // Note: `Layer.mergeAll` does not wire sibling layers' dependencies into
    // each other — it's a flat union, not a dependency graph (verified: a
    // service depending on another `Effect.Service` sibling here fails at
    // runtime with "Service not found: <Tag>" unless wired explicitly). If
    // your service depends on another `Effect.Service` (e.g. `EventBus`),
    // provide it explicitly: `YourService.Default.pipe(Layer.provide(TheDependency.Default))`
    // — `Layer.provide`'s outer `infra` below still only has to appear once,
    // thanks to Effect's default layer memoization. `sshCa`/`tunnel` need
    // `provideMerge` rather than this pattern — see the comment above.
  ).pipe(Layer.provide(infra));
};
