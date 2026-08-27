import { HttpApiBuilder } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { config } from "./config";
import { Api } from "./http/api";
import { AgentProtocolLive } from "./http/handlers/agent-protocol";
import { HealthLive } from "./http/handlers/health";
import { buildAppLive } from "./layers";
import { FakeProvisioningServiceLive } from "./services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "./services/SecretsProvider.fake";
import { LocalSignerLive } from "./services/Signer.local";
import { JoinTokenAttestationLive } from "./services/attestation/JoinTokenAttestation";

// Fakes by default for this skeleton — a real deployment would swap the
// Azure-backed adapters in here, but no Azure account exists in this build
// (see Signer.azure.ts / ProvisioningService.azure.ts). Join-token
// attestation is real (not a fake) — it's first-class per spec §9, not a
// placeholder for an Azure managed-identity implementation unit 4 adds
// alongside it.
const AppLive = buildAppLive({
  provisioning: FakeProvisioningServiceLive,
  signer: LocalSignerLive,
  secrets: FakeSecretsProviderLive,
  attestation: JoinTokenAttestationLive,
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(Layer.mergeAll(HealthLive, AgentProtocolLive)),
);

const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provide(AppLive),
  Layer.provide(BunHttpServer.layer({ port: config.port })),
);

Layer.launch(ServerLive).pipe(BunRuntime.runMain);
