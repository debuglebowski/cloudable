import { HttpApiBuilder, HttpMiddleware } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { config } from "./config";
import { DbLive } from "./db/layer";
import { EvidenceLive } from "./evidence/handler";
import { Api } from "./http/api";
import { AccessLive } from "./http/handlers/access";
import { AgentProtocolLive } from "./http/handlers/agent-protocol";
import { ApprovalsLive } from "./http/handlers/approvals";
import { ArchiveLive } from "./http/handlers/archive";
import { CatalogLive } from "./http/handlers/catalog";
import { ComplianceLive } from "./http/handlers/compliance";
import { ConfigLive } from "./http/handlers/config";
import { ElevationsLive } from "./http/handlers/elevations";
import { FederationLive } from "./http/handlers/federation";
import { HealthLive } from "./http/handlers/health";
import { IntegrationsLive } from "./http/handlers/integrations";
import { MachinesLive } from "./http/handlers/machines";
import { NotificationsLive } from "./http/handlers/notifications";
import { OffboardingHttpLive } from "./http/handlers/offboarding";
import { OrganisationLive } from "./http/handlers/organisation";
import { PeopleLive } from "./http/handlers/people";
import { ProvisioningCapabilitiesLive } from "./http/handlers/provisioning-capabilities";
import { RestartLive } from "./http/handlers/restart";
import { AccessAttachRouteLive, TunnelConnectRouteLive, TunnelLive } from "./http/handlers/tunnel";
import { TunnelSignalLive } from "./http/handlers/tunnel-signal";
import { UpgradeLive } from "./http/handlers/upgrade";
import { AgentWakeRouteLive, WakeRegistry } from "./http/routes/agent-wake";
import { AuthRouteLive } from "./http/routes/auth";
import { BinariesRouteLive } from "./http/routes/binaries";
import { buildAppLive } from "./layers";
import { seedAzureImages } from "./services/CloudCatalogService";
import { SwitchableProvisioningServiceLive } from "./services/ProvisioningService.switchable";
import { FakeSecretsProviderLive } from "./services/SecretsProvider.fake";
import { LocalSignerLive } from "./services/Signer.local";
import { TunnelRegistry } from "./tunnel/registry";

// Fakes by default for this skeleton — a real deployment would swap the
// Azure-backed adapters in here, but no Azure account exists in this build
// (see Signer.azure.ts / ProvisioningService.azure.ts). Attestation isn't
// swappable here at all — see `layers.ts`'s doc comment on `buildAppLive`
// for why both join-token and managed-identity are always wired in live.
//
// `provisioning` dispatches at call time between fake/docker/azure, per the
// `provider` each call carries — no more single process-wide adapter choice
// (see `ProvisioningService.switchable.ts`). Which providers an org may
// actually pick is real product state now (`GET /api/v1/integrations`,
// `kind: "cloud"`), not a boot-time env var.
const AppLive = buildAppLive({
  provisioning: SwitchableProvisioningServiceLive,
  signer: LocalSignerLive,
  secrets: FakeSecretsProviderLive,
});

// `buildAppLive` deliberately keeps `Db` internal to the services it wires (see
// layers.ts) rather than re-exposing it. Handler groups whose domain logic reads `Db`
// directly (EvidenceLive, ArchiveLive, UpgradeLive, ConfigLive, NotificationsLive,
// RestartLive) need it provided here too. `DbLive` is a single scoped layer shared by
// reference, so this does not open a second Postgres connection pool alongside the one
// inside `AppLive`.
const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(
    Layer.mergeAll(
      ElevationsLive,
      UpgradeLive,
      OffboardingHttpLive,
      HealthLive,
      MachinesLive,
      AgentProtocolLive,
      ApprovalsLive,
      ComplianceLive,
      EvidenceLive,
      ArchiveLive,
      ConfigLive,
      FederationLive,
      AccessLive,
      PeopleLive,
      OrganisationLive,
      IntegrationsLive,
      TunnelSignalLive,
      TunnelLive,
      NotificationsLive,
      RestartLive,
      CatalogLive,
      ProvisioningCapabilitiesLive,
    ),
  ),
  Layer.provide(DbLive),
);

// Not part of `Api`/`ApiLive` above — `wake` is a raw route on the same shared
// `HttpApiBuilder.Router`, not an `HttpApiEndpoint` (see agent-wake.ts) — but it needs the
// same `AgentSessionToken`/`MachineDirectory` singletons `AgentProtocolLive` uses, which
// `AppLive` (provided to `ServerLive` below) already supplies.
const AgentWakeLive = AgentWakeRouteLive.pipe(Layer.provide(WakeRegistry.Default));

// Raw websocket-upgrade routes on the same shared router (an `HttpApiEndpoint` can't model
// an upgrade at all — see `agent-wake.ts`'s doc comment), same reasoning as `AgentWakeLive`
// above — not part of `Api`/`ApiLive`.
const TunnelRoutesLive = Layer.mergeAll(TunnelConnectRouteLive, AccessAttachRouteLive).pipe(
  Layer.provide(TunnelRegistry.Default),
);

// Every console page fetches cross-origin (console and control-plane run on
// different ports in local dev, and there's no reverse proxy in front of
// either yet) — without this, the browser silently withholds every response
// body from JS, which surfaces as every query on every page failing at once.
const ServerLive = HttpApiBuilder.serve(
  HttpMiddleware.cors({ allowedOrigins: [config.consoleOrigin], credentials: true }),
).pipe(
  Layer.provide(ApiLive),
  Layer.provide(AgentWakeLive),
  Layer.provide(TunnelRoutesLive),
  Layer.provide(AuthRouteLive),
  Layer.provide(BinariesRouteLive),
  Layer.provide(AppLive),
  Layer.provide(BunHttpServer.layer({ port: config.port })),
);

// Unlike the Azure region catalog (a real ARM call, only ever triggered by
// an admin's "Sync from Azure" click — see `CloudCatalogService.ts`), the
// image catalog has no external dependency at all: it's a static mirror of
// `ProvisioningService.azure.ts`'s own `UBUNTU_IMAGES` map. Nothing else
// ever called `seedAzureImages()` — without this, an org's Azure image
// catalog would stay permanently empty (no button, no boot hook) and every
// azure machine-creation request would fail image validation forever.
// Idempotent upsert, safe to run unconditionally on every boot; logged and
// swallowed on failure (e.g. a fresh DB whose migrations haven't run yet)
// rather than blocking the server from starting over a non-essential seed.
const seedCatalogDefaults = seedAzureImages().pipe(
  Effect.provide(DbLive),
  Effect.tap(() => Effect.logInfo("seeded Azure image catalog from UBUNTU_IMAGES")),
  Effect.catchAll((cause) => Effect.logWarning(`Azure image catalog seed skipped: ${cause}`)),
);

Effect.runPromise(seedCatalogDefaults).then(() => {
  Layer.launch(ServerLive).pipe(BunRuntime.runMain);
});
