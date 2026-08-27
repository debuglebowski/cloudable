import { HttpApiBuilder } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { config } from "./config";
import { DbLive } from "./db/layer";
import { Api } from "./http/api";
import { ArchiveLive } from "./http/handlers/archive";
import { HealthLive } from "./http/handlers/health";
import { buildAppLive } from "./layers";
import { FakeProvisioningServiceLive } from "./services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "./services/SecretsProvider.fake";
import { LocalSignerLive } from "./services/Signer.local";

// Fakes by default for this skeleton — a real deployment would swap the
// Azure-backed adapters in here, but no Azure account exists in this build
// (see Signer.azure.ts / ProvisioningService.azure.ts).
const AppLive = buildAppLive({
  provisioning: FakeProvisioningServiceLive,
  signer: LocalSignerLive,
  secrets: FakeSecretsProviderLive,
});

// `buildAppLive` deliberately keeps `Db` internal to the services it wires (see
// layers.ts) rather than re-exposing it. Handler groups whose domain logic reads `Db`
// directly (a plain-function domain, e.g. `ArchiveLive` — see domain/archive) need it
// provided here too. `DbLive` is a single scoped layer shared by reference, so this
// does not open a second Postgres connection.
const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(HealthLive),
  Layer.provide(ArchiveLive),
  Layer.provide(DbLive),
);

const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provide(AppLive),
  Layer.provide(BunHttpServer.layer({ port: config.port })),
);

Layer.launch(ServerLive).pipe(BunRuntime.runMain);
