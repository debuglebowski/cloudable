import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ApprovalService } from "./services/ApprovalService";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";
import { AgentSessionToken } from "./services/attestation/AgentSessionToken";
import type { AttestationMethodTag } from "./services/attestation/AttestationMethod";
import { MachineDirectory } from "./services/attestation/MachineDirectory";

export const buildAppLive = (adapters: {
  provisioning: Layer.Layer<ProvisioningServiceTag>;
  signer: Layer.Layer<SignerTag>;
  secrets: Layer.Layer<SecretsProviderTag>;
  attestation: Layer.Layer<AttestationMethodTag>;
}) =>
  Layer.mergeAll(
    EventBus.Default,
    ApprovalService.Default,
    AgentSessionToken.Default,
    MachineDirectory.Default,
    adapters.provisioning,
    adapters.signer,
    adapters.secrets,
    adapters.attestation,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
  ).pipe(Layer.provide(Layer.mergeAll(AppConfigLive, DbLive)));
