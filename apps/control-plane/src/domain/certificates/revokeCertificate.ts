import { certificates } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

export class CertificateRevokeError extends Data.TaggedError("CertificateRevokeError")<{
  reason: "not_found" | "db_error";
  cause?: unknown;
}> {}

export interface RevokedCertificate {
  certificateId: string;
  revokedAt: Date;
}

/**
 * STUB for unit 12's certificate revocation logic (`revokeCertificate`).
 * No path was mandated for that unit, so this is a best-guess consolidation
 * point at `domain/certificates/*` — flagged in the PR. Callers
 * (`domain/offboarding/CertificateRevoker.default.ts`) depend only on this
 * function's name and signature
 * (`revokeCertificate(certificateId, reason): Effect<RevokedCertificate, CertificateRevokeError, Db>`),
 * so re-pointing at unit 12's real implementation once merged is a one-line
 * change.
 *
 * Minimal working behavior: marks the certificate row revoked in the
 * database. Does not (yet) push the revocation to a live agent/session —
 * that propagation is unit 12's concern, not this stub's.
 */
export const revokeCertificate = (
  certificateId: string,
  reason: string,
): Effect.Effect<RevokedCertificate, CertificateRevokeError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = new Date();

    const [updated] = yield* Effect.tryPromise({
      try: () =>
        db
          .update(certificates)
          .set({ revokedAt: now, revokedReason: reason })
          .where(eq(certificates.id, certificateId))
          .returning(),
      catch: (cause) => new CertificateRevokeError({ reason: "db_error", cause }),
    });

    if (!updated) {
      return yield* Effect.fail(
        new CertificateRevokeError({ reason: "not_found", cause: certificateId }),
      );
    }

    return { certificateId: updated.id, revokedAt: now };
  });
