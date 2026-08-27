import { Layer } from "effect";
import { AppConfigLive } from "./config";
import { DbLive } from "./db/layer";
import { ApprovalService } from "./services/ApprovalService";
import { EventBus } from "./services/EventBus";
import type { ProvisioningServiceTag } from "./services/ProvisioningService";
import type { SecretsProviderTag } from "./services/SecretsProvider";
import type { SignerTag } from "./services/Signer";
import { SshCaService } from "./services/ssh-ca/SshCaService";
import { TunnelServer } from "./tunnel/server";

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
  const tunnel = TunnelServer.Default.pipe(
    Layer.provideMerge(Layer.mergeAll(eventBus, adapters.signer, infra)),
  );

  return Layer.mergeAll(
    eventBus,
    ApprovalService.Default,
    adapters.provisioning,
    adapters.signer,
    adapters.secrets,
    sshCa,
    tunnel,
    // Feature units: append your service's `.Default` (or Layer) to the Layer.mergeAll(...) argument
    // list above. Never reorder existing entries.
  ).pipe(Layer.provide(infra));
};
