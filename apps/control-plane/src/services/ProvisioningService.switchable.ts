// Dispatching `ProvisioningService` that lets a running control-plane switch
// between fake/docker/azure without a process restart — see
// `http/handlers/dev-provisioning.ts` for the (guarded, dev-only) endpoint
// that flips it. Never a customer-facing concept, same as `.docker.ts` and
// `.fake.ts` themselves; the guard there is what actually keeps a real
// (`PROVISIONING_ADAPTER=azure`) deployment from ever being switched away
// from Azure at runtime — this file just holds the switch.
import { Effect, Layer, Schema } from "effect";
import { type ProvisioningAdapter, config } from "../config";
import { type ProvisioningService, ProvisioningServiceTag } from "./ProvisioningService";
import { AzureProvisioningServiceLive } from "./ProvisioningService.azure";
import { makeDockerProvisioningServiceLive } from "./ProvisioningService.docker";
import { FakeProvisioningServiceLive } from "./ProvisioningService.fake";

export class ProvisioningAdapterNotOverridableError extends Schema.TaggedError<ProvisioningAdapterNotOverridableError>()(
  "ProvisioningAdapterNotOverridableError",
  { reason: Schema.String },
) {}

/**
 * Plain module-level mutable state, not an Effect `Ref` behind a second
 * `Context.Tag` — `buildAppLive`'s `adapters.provisioning` param is typed
 * exactly `Layer.Layer<ProvisioningServiceTag>` (see `layers.ts`), and this
 * is single-process dev/demo tooling, not domain state that needs to travel
 * through the layer graph. A `let` closed over by both this dispatcher and
 * the HTTP handler below is simpler and just as correct here (Bun is
 * single-threaded; there's no torn-read concern a `Ref` would guard against).
 */
let currentAdapter: ProvisioningAdapter = config.provisioningAdapter;

export const getCurrentProvisioningAdapter = (): ProvisioningAdapter => currentAdapter;

/** Never call this without checking `provisioningAdapterOverridable()` first — see that function's doc comment. */
export const setCurrentProvisioningAdapter = (adapter: ProvisioningAdapter): void => {
  currentAdapter = adapter;
};

/**
 * `false` once and for all when this process booted with
 * `PROVISIONING_ADAPTER=azure` — a real deployment always boots that way, so
 * this permanently forbids switching away from Azure for the life of the
 * process, regardless of what the console sends. This is the actual
 * enforcement; the console hiding the control in a production build
 * (`import.meta.env.DEV`) is only the UX half of it.
 */
export const provisioningAdapterOverridable = (): boolean => config.provisioningAdapter !== "azure";

/**
 * Builds all three real implementations once, unconditionally, at boot —
 * they're cheap `Layer.succeed`/pure objects (no eager Docker/Azure calls;
 * `.docker.ts`'s own shell-outs only happen inside its methods) — and
 * dispatches every call to whichever one `currentAdapter` names right now.
 * Mirrors `services/attestation/registry.ts`'s "hold every implementation,
 * dispatch at call time" shape, applied to a mutable switch instead of a
 * per-request field.
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

    const implFor = (adapter: ProvisioningAdapter): ProvisioningService =>
      adapter === "docker" ? docker : adapter === "azure" ? azure : fake;

    return {
      create: (desc) => implFor(currentAdapter).create(desc),
      archive: (machineId) => implFor(currentAdapter).archive(machineId),
      reconcile: (machineId) => implFor(currentAdapter).reconcile(machineId),
      reimage: (desc) => implFor(currentAdapter).reimage(desc),
      restart: (machineId) => implFor(currentAdapter).restart(machineId),
    } satisfies ProvisioningService;
  }),
);
