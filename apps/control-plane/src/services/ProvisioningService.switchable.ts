// Dispatching `ProvisioningService` that routes each call to the
// fake/docker/azure implementation named by that call's own `provider` —
// see `ProvisioningService.ts`'s doc comment on why `archive`/`reconcile`/
// `restart` take it as an explicit parameter rather than this file looking
// it up itself. Provider is now a real per-machine, org-enabled choice (the
// Integrations page — see `docs/frontend.md`), not a single process-wide
// dev toggle: there is no longer a mutable "current adapter" here at all.
import { Effect, Layer } from "effect";
import { config } from "../config";
import {
  type Provider,
  type ProvisioningService,
  ProvisioningServiceTag,
} from "./ProvisioningService";
import { AzureProvisioningServiceLive } from "./ProvisioningService.azure";
import { makeDockerProvisioningServiceLive } from "./ProvisioningService.docker";
import { FakeProvisioningServiceLive } from "./ProvisioningService.fake";

/**
 * Builds all three real implementations once, unconditionally, at boot —
 * they're cheap `Layer.succeed`/pure objects (no eager Docker/Azure calls;
 * `.docker.ts`'s own shell-outs only happen inside its methods, and
 * `.azure.ts`'s ARM clients are constructed lazily on first real call) — and
 * dispatches every call to whichever one that call's own `provider` names.
 */
export const SwitchableProvisioningServiceLive: Layer.Layer<ProvisioningServiceTag> = Layer.effect(
  ProvisioningServiceTag,
  Effect.gen(function* () {
    const fake = yield* Effect.provide(ProvisioningServiceTag, FakeProvisioningServiceLive);
    const docker = yield* Effect.provide(
      ProvisioningServiceTag,
      makeDockerProvisioningServiceLive({ controlPlaneUrl: config.localDockerControlPlaneUrl }),
    );
    const azure = yield* Effect.provide(ProvisioningServiceTag, AzureProvisioningServiceLive);

    const implFor = (provider: Provider): ProvisioningService =>
      provider === "docker" ? docker : provider === "azure" ? azure : fake;

    return {
      create: (desc) => implFor(desc.provider).create(desc),
      archive: (machineId, provider) => implFor(provider).archive(machineId, provider),
      reconcile: (machineId, provider) => implFor(provider).reconcile(machineId, provider),
      reimage: (desc) => implFor(desc.provider).reimage(desc),
      restart: (machineId, provider) => implFor(provider).restart(machineId, provider),
    } satisfies ProvisioningService;
  }),
);
