import { Layer } from "effect";
import { EventBus } from "../../services/EventBus";
import { DefaultCertificateRevokerLive } from "./CertificateRevoker.default";
import { DefaultMachineArchiverLive } from "./MachineArchiver.default";
import { DrizzleOffboardingRepoLive } from "./OffboardingRepo.drizzle";

export {
  offboardPerson,
  offboardPersonDetailed,
  type OffboardPersonOutcome,
} from "./offboardPerson";
export { OffboardingError } from "./errors";
export { OffboardingRepoTag, type OffboardingRepo } from "./OffboardingRepo";
export { CertificateRevokerTag, type CertificateRevoker } from "./CertificateRevoker";
export { MachineArchiverTag, type MachineArchiver } from "./MachineArchiver";

/**
 * Every layer `offboardPersonDetailed`/`offboardPerson` needs beyond the
 * shared services already registered in `layers.ts` (`ApprovalService`,
 * `EventBus`) and the provisioning adapter chosen in `server.ts`
 * (`ProvisioningServiceTag`). Register this in `layers.ts`'s
 * `Layer.mergeAll(...)` alongside the other feature units' layers.
 *
 * `DefaultCertificateRevokerLive` and `DefaultMachineArchiverLive` are
 * stand-ins for unit 12 and unit 15 respectively — see the doc comments on
 * `domain/certificates/revokeCertificate.ts` and
 * `domain/archive/archiveMachine.ts` for the expected consolidation.
 */
export const OffboardingLive = Layer.mergeAll(
  DrizzleOffboardingRepoLive,
  DefaultCertificateRevokerLive,
  DefaultMachineArchiverLive,
).pipe(
  // `DefaultMachineArchiverLive` needs `EventBus` (to emit `machine.archived`).
  // `EventBus.Default` is memoized by reference, so providing it here shares
  // the same instance as the top-level `EventBus.Default` in `layers.ts`
  // rather than building a second one — `Db` (needed transitively by
  // `EventBus.Default` itself, and directly by the other two layers here)
  // stays an open requirement, resolved by `layers.ts`'s outer `DbLive`.
  Layer.provide(EventBus.Default),
);
