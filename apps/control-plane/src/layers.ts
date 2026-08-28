import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { MachineService } from "./domain/machine/MachineService";
import { ApprovalService } from "./services/ApprovalService";
import { AttestationRegistryLive } from "./services/attestation/registry";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";
import { AgentSessionToken } from "./services/attestation/AgentSessionToken";
import { MachineDirectory } from "./services/attestation/MachineDirectory";

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
    ApprovalService.Default,
    MachineService.Default,
    AgentSessionToken.Default,
    MachineDirectory.Default,
    adapters.provisioning,
    adapters.signer,
    adapters.secrets,
    AttestationRegistryLive,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
