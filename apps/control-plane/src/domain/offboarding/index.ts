import { Layer } from "effect";
import { EventBus } from "../../services/EventBus";
import { DefaultCertificateRevokerLive } from "./CertificateRevoker.default";
import { DefaultMachineArchiverLive } from "./MachineArchiver.default";
import { DrizzleOffboardingRepoLive } from "./OffboardingRepo.drizzle";
import { DefaultSessionTerminatorLive } from "./SessionTerminator.default";

export {
  offboardPerson,
  offboardPersonDetailed,
  resumeOffboarding,
  type OffboardPersonOutcome,
} from "./offboardPerson";
export { OffboardingError } from "./errors";
export { OffboardingRepoTag, type OffboardingRepo } from "./OffboardingRepo";
export { CertificateRevokerTag, type CertificateRevoker } from "./CertificateRevoker";
export { MachineArchiverTag, type MachineArchiver } from "./MachineArchiver";
export { SessionTerminatorTag, type SessionTerminator } from "./SessionTerminator";

/**
 * Every layer `offboardPersonDetailed`/`offboardPerson` needs beyond the
 * shared services already registered in `layers.ts` (`ApprovalService`,
 * `EventBus`) and the provisioning adapter chosen in `server.ts`
 * (`ProvisioningServiceTag`). Register this in `layers.ts`'s
 * `Layer.mergeAll(...)` alongside the other feature units' layers.
 *
 * `DefaultMachineArchiverLive` now delegates to unit 15's real
 * `domain/archive/archive.ts`'s `archiveMachine` (consolidated at merge
 * time). `DefaultCertificateRevokerLive` still delegates to a stand-in at
 * `domain/certificates/revokeCertificate.ts` pending unit 12's real
 * certificate-revocation logic — see that file's doc comment for the
 * expected consolidation once unit 12 merges. `DefaultSessionTerminatorLive`
 * needs `TunnelRelay` — a caller-provided requirement this layer leaves
 * open, same as `ProvisioningServiceTag` below (see `layers.ts`'s
 * `OffboardingLive.pipe(Layer.provide(adapters.provisioning), Layer.provide(tunnelRelay))`).
 */
export const OffboardingLive = Layer.mergeAll(
  DrizzleOffboardingRepoLive,
  DefaultCertificateRevokerLive,
  DefaultMachineArchiverLive,
  DefaultSessionTerminatorLive,
).pipe(
  // `DefaultMachineArchiverLive` needs `EventBus` (to emit `machine.archived`).
  // `EventBus.Default` is memoized by reference, so providing it here shares
  // the same instance as the top-level `EventBus.Default` in `layers.ts`
  // rather than building a second one — `Db` (needed transitively by
  // `EventBus.Default` itself, and directly by the other two layers here)
  // stays an open requirement, resolved by `layers.ts`'s outer `DbLive`.
  Layer.provide(EventBus.Default),
);
