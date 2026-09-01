import { HttpApiBuilder, HttpMiddleware } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { config } from "./config";
import { DbLive } from "./db/layer";
import { EvidenceLive } from "./evidence/handler";
import { Api } from "./http/api";
import { AccessLive } from "./http/handlers/access";
import { AgentProtocolLive } from "./http/handlers/agent-protocol";
import { ApprovalsLive } from "./http/handlers/approvals";
import { ArchiveLive } from "./http/handlers/archive";
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
import { AccessAttachRouteLive, TunnelConnectRouteLive, TunnelLive } from "./http/handlers/tunnel";
import { TunnelSignalLive } from "./http/handlers/tunnel-signal";
import { UpgradeLive } from "./http/handlers/upgrade";
import { AgentWakeRouteLive, WakeRegistry } from "./http/routes/agent-wake";
import { AuthRouteLive } from "./http/routes/auth";
import { buildAppLive } from "./layers";
import { AzureProvisioningServiceLive } from "./services/ProvisioningService.azure";
import { makeDockerProvisioningServiceLive } from "./services/ProvisioningService.docker";
import { FakeProvisioningServiceLive } from "./services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "./services/SecretsProvider.fake";
import { LocalSignerLive } from "./services/Signer.local";
import { TunnelRegistry } from "./tunnel/registry";

// Fakes by default for this skeleton — a real deployment would swap the
// Azure-backed adapters in here, but no Azure account exists in this build
// (see Signer.azure.ts / ProvisioningService.azure.ts). Attestation isn't
// swappable here at all — see `layers.ts`'s doc comment on `buildAppLive`
// for why both join-token and managed-identity are always wired in live.
//
// `provisioning` is the one adapter actually selectable via env
// (`PROVISIONING_ADAPTER`, see config.ts) — `"docker"` runs real local
// containers for dev/demo without an Azure account; never a customer-facing
// choice, just how this process happens to be booted.
const provisioningLive =
  config.provisioningAdapter === "docker"
    ? makeDockerProvisioningServiceLive({ controlPlaneUrl: config.localDockerControlPlaneUrl })
    : config.provisioningAdapter === "azure"
      ? AzureProvisioningServiceLive
      : FakeProvisioningServiceLive;

const AppLive = buildAppLive({
  provisioning: provisioningLive,
  signer: LocalSignerLive,
  secrets: FakeSecretsProviderLive,
});

// `buildAppLive` deliberately keeps `Db` internal to the services it wires (see
// layers.ts) rather than re-exposing it. Handler groups whose domain logic reads `Db`
// directly (EvidenceLive, ArchiveLive, UpgradeLive, ConfigLive, NotificationsLive) need it
// provided here too. `DbLive` is a single scoped layer shared by reference, so this does
// not open a second Postgres connection pool alongside the one inside `AppLive`.
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
  HttpMiddleware.cors({ allowedOrigins: [config.consoleOrigin] }),
).pipe(
  Layer.provide(ApiLive),
  Layer.provide(AgentWakeLive),
  Layer.provide(TunnelRoutesLive),
  Layer.provide(AuthRouteLive),
  Layer.provide(AppLive),
  Layer.provide(BunHttpServer.layer({ port: config.port })),
);

Layer.launch(ServerLive).pipe(BunRuntime.runMain);
