import { certificates } from "@cloudable/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";

export class CertificateRevokeError extends Data.TaggedError("CertificateRevokeError")<{
  reason: "not_found" | "already_revoked" | "db_error";
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

    // Guard against re-revoking an already-revoked certificate: without
    // `isNull(revokedAt)` in the WHERE clause, a second revoke call (a retry,
    // a race between two admins, offboarding running twice) would silently
    // overwrite the original revokedAt/revokedReason with the new call's
    // values — corrupting the audit trail the "access revoked on
    // offboarding" compliance check relies on.
    const [updated] = yield* Effect.tryPromise({
      try: () =>
        db
          .update(certificates)
          .set({ revokedAt: now, revokedReason: reason })
          .where(and(eq(certificates.id, certificateId), isNull(certificates.revokedAt)))
          .returning(),
      catch: (cause) => new CertificateRevokeError({ reason: "db_error", cause }),
    });

    if (updated) {
      return { certificateId: updated.id, revokedAt: now };
    }

    // No row updated — either it doesn't exist, or it does but was already
    // revoked. Distinguish the two so a caller (and its audit trail) can
    // tell "nothing to revoke" from "already handled".
    const [existing] = yield* Effect.tryPromise({
      try: () => db.select().from(certificates).where(eq(certificates.id, certificateId)).limit(1),
      catch: (cause) => new CertificateRevokeError({ reason: "db_error", cause }),
    });

    return yield* Effect.fail(
      existing
        ? new CertificateRevokeError({ reason: "already_revoked", cause: certificateId })
        : new CertificateRevokeError({ reason: "not_found", cause: certificateId }),
    );
  });
