import { Context, type Effect } from "effect";
import type { CertificateRevokeError, RevokedCertificate } from "../certificates/revokeCertificate";

/**
 * Port wrapping unit 12's certificate revocation logic
 * (`domain/certificates/revokeCertificate`), so `offboardPerson` can be
 * unit-tested against a mock without touching the database — mirrors how
 * `ProvisioningServiceTag` wraps cloud provisioning.
 */
export interface CertificateRevoker {
  revoke: (
    certificateId: string,
    reason: string,
  ) => Effect.Effect<RevokedCertificate, CertificateRevokeError>;
}

export class CertificateRevokerTag extends Context.Tag("CertificateRevoker")<
  CertificateRevokerTag,
  CertificateRevoker
>() {}
