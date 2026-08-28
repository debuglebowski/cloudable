import { HttpApiBuilder } from "@effect/platform";
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
import { MachinesLive } from "./http/handlers/machines";
import { OffboardingHttpLive } from "./http/handlers/offboarding";
import { UpgradeLive } from "./http/handlers/upgrade";
import { buildAppLive } from "./layers";
import { FakeProvisioningServiceLive } from "./services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "./services/SecretsProvider.fake";
import { LocalSignerLive } from "./services/Signer.local";

// Fakes by default for this skeleton — a real deployment would swap the
// Azure-backed adapters in here, but no Azure account exists in this build
// (see Signer.azure.ts / ProvisioningService.azure.ts). Attestation isn't
// swappable here at all — see `layers.ts`'s doc comment on `buildAppLive`
// for why both join-token and managed-identity are always wired in live.
const AppLive = buildAppLive({
  provisioning: FakeProvisioningServiceLive,
  signer: LocalSignerLive,
  secrets: FakeSecretsProviderLive,
});

// `buildAppLive` deliberately keeps `Db` internal to the services it wires (see
// layers.ts) rather than re-exposing it. Handler groups whose domain logic reads `Db`
// directly (EvidenceLive, ArchiveLive, UpgradeLive, ConfigLive) need it provided here too. `DbLive`
// is a single scoped layer shared by reference, so this does not open a second
// Postgres connection pool alongside the one inside `AppLive`.
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
    ),
  ),
  Layer.provide(DbLive),
);

const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provide(AppLive),
  Layer.provide(BunHttpServer.layer({ port: config.port })),
);

Layer.launch(ServerLive).pipe(BunRuntime.runMain);
