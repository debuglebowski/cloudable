import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { revokeCertificate } from "../certificates/revokeCertificate";
import { type CertificateRevoker, CertificateRevokerTag } from "./CertificateRevoker";

/**
 * Default `CertificateRevoker` — delegates to `domain/certificates/revokeCertificate`
 * (unit 12's stub until unit 12 merges), resolving `Db` once at layer
 * construction so the port itself carries no further requirements. Used by
 * the running server.
 */
export const DefaultCertificateRevokerLive = Layer.effect(
  CertificateRevokerTag,
  Effect.gen(function* () {
    const db = yield* Db;

    const revoke: CertificateRevoker["revoke"] = (certificateId, reason) =>
      revokeCertificate(certificateId, reason).pipe(Effect.provideService(Db, db));

    return { revoke } satisfies CertificateRevoker;
  }),
);
