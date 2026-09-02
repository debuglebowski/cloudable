import { certificates } from "@cloudable/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";
import { EventBus } from "../EventBus";
import { SignerTag } from "../Signer";
import {
  CERT_TYPE_USER,
  type CertificateFields,
  assembleCertificate,
  ed25519PublicKeyBlob,
  encodeCertificateBody,
  encodeSignatureField,
  formatAsOpenSshLine,
  rawEd25519FromSpki,
  sha256Fingerprint,
} from "./openssh-cert";

export class SshCaError extends Data.TaggedError("SshCaError")<{
  reason: "invalid_public_key" | "not_found" | "sign_failed" | "persist_failed";
  cause?: unknown;
}> {}

/**
 * `Signer` keyId for the SSH CA's own signing key. Deliberately a distinct
 * key from the session-token signer (`tunnel/session-token.ts`'s
 * `SESSION_TOKEN_KEY_ID`) — "the same Key Vault sign operation as the
 * SSH CA" is read as *the same port/mechanism*, not literally the same key;
 * separating the two keeps a session-token compromise from also being able
 * to mint SSH certificates. See `docs/access.md`.
 */
export const SSH_CA_KEY_ID = "ssh-ca";

/** ~8h validity window. */
export const CERTIFICATE_TTL_SECONDS = 8 * 60 * 60;

export type MachineScope = "all" | ReadonlyArray<string>;

export interface IssueCertificateInput {
  orgId: string;
  personId: string;
  osUser: string;
  machineScope: MachineScope;
  /** Raw 32-byte Ed25519 point of the caller's ephemeral keypair — not SSH-wire-framed, not a private key. */
  subjectPublicKeyRaw: Uint8Array;
}

export interface IssuedCertificate {
  certificateId: string;
  certificate: string;
  fingerprint: string;
  expiresAt: Date;
}

export interface CertificateRow {
  id: string;
  personId: string;
  machineScope: MachineScope;
  fingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

const serializeMachineScope = (scope: MachineScope): string =>
  typeof scope === "string" ? scope : scope.join(",");

/**
 * The Cloudable SSH CA. Assembles OpenSSH user certificates (see
 * `openssh-cert.ts` for the wire format) and calls `Signer.sign()` for the
 * one operation that needs the CA private key — this service never
 * generates, imports, or holds key material itself. Persists to
 * `certificates` and emits `access.certificate_issued` /
 * `access.certificate_revoked` via `EventBus` (append-only).
 */
export class SshCaService extends Effect.Service<SshCaService>()("SshCaService", {
  effect: Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const signer = yield* SignerTag;

    const caPublicKeyRaw = (): Effect.Effect<Uint8Array, SshCaError> =>
      signer.publicKey(SSH_CA_KEY_ID).pipe(
        Effect.map((spki) => rawEd25519FromSpki(spki)),
        Effect.mapError((cause) => new SshCaError({ reason: "sign_failed", cause })),
      );

    const issueCertificate = (
      input: IssueCertificateInput,
    ): Effect.Effect<IssuedCertificate, SshCaError> =>
      Effect.gen(function* () {
        if (input.subjectPublicKeyRaw.length !== 32) {
          return yield* Effect.fail(
            new SshCaError({
              reason: "invalid_public_key",
              cause: `expected a 32-byte Ed25519 point, got ${input.subjectPublicKeyRaw.length} bytes`,
            }),
          );
        }

        const caRaw = yield* caPublicKeyRaw();

        const now = new Date();
        const expiresAt = new Date(now.getTime() + CERTIFICATE_TTL_SECONDS * 1000);
        const nonce = crypto.getRandomValues(new Uint8Array(32));

        const fields: CertificateFields = {
          nonce,
          subjectPublicKeyRaw: input.subjectPublicKeyRaw,
          // Unspecified (0) — this CA does not maintain a Key Revocation List; the short
          // TTL plus the `certificates` table's `revokedAt` (checked at the tunnel/session
          // layer, not by sshd) are the revocation story. See docs/access.md.
          serial: 0n,
          certType: CERT_TYPE_USER,
          keyId: `cloudable:${input.personId}`,
          validPrincipals: [input.osUser],
          // Small backdate to tolerate clock skew between the control plane and the
          // machine verifying the certificate.
          validAfter: BigInt(Math.floor(now.getTime() / 1000) - 60),
          validBefore: BigInt(Math.floor(expiresAt.getTime() / 1000)),
          extensions: [{ name: "permit-pty" }],
          caPublicKeyRaw: caRaw,
        };

        const body = encodeCertificateBody(fields);
        const signature = yield* signer
          .sign({ keyId: SSH_CA_KEY_ID, algorithm: "ed25519", data: body })
          .pipe(Effect.mapError((cause) => new SshCaError({ reason: "sign_failed", cause })));

        const blob = assembleCertificate(body, encodeSignatureField(signature));
        const certificateLine = formatAsOpenSshLine(blob, `${input.personId}@cloudable`);
        const fingerprint = sha256Fingerprint(ed25519PublicKeyBlob(input.subjectPublicKeyRaw));

        const certificateId = yield* Effect.tryPromise({
          try: async () => {
            const [row] = await db
              .insert(certificates)
              .values({
                orgId: input.orgId,
                personId: input.personId,
                machineScope: input.machineScope,
                fingerprint,
                issuedAt: now,
                expiresAt,
              })
              .returning({ id: certificates.id });
            if (!row) throw new Error("insert returned no row");
            return row.id;
          },
          catch: (cause) => new SshCaError({ reason: "persist_failed", cause }),
        });

        yield* eventBus
          .publish([
            {
              // `id`/`recordedAt` are placeholders — `EventBus.publish` always overwrites both.
              id: "",
              recordedAt: now,
              type: "access.certificate_issued",
              occurredAt: now,
              orgId: input.orgId,
              actorType: "person",
              actorId: input.personId,
              machineId: null,
              correlationId: certificateId,
              schemaVersion: 1,
              payload: {
                principal: input.osUser,
                expiresAt: expiresAt.toISOString(),
                machineScope: serializeMachineScope(input.machineScope),
              },
            },
          ])
          .pipe(Effect.mapError((cause) => new SshCaError({ reason: "persist_failed", cause })));

        return { certificateId, certificate: certificateLine, fingerprint, expiresAt };
      });

    const revokeCertificate = (input: {
      certificateId: string;
      orgId: string;
      reason: string;
    }): Effect.Effect<void, SshCaError> =>
      Effect.gen(function* () {
        const now = new Date();
        const updated = yield* Effect.tryPromise({
          try: () =>
            db
              .update(certificates)
              .set({ revokedAt: now, revokedReason: input.reason })
              .where(
                and(
                  eq(certificates.id, input.certificateId),
                  eq(certificates.orgId, input.orgId),
                  isNull(certificates.revokedAt),
                ),
              )
              .returning(),
          catch: (cause) => new SshCaError({ reason: "persist_failed", cause }),
        });

        const row = updated[0];
        if (!row) {
          return yield* Effect.fail(
            new SshCaError({
              reason: "not_found",
              cause: `no live certificate ${input.certificateId} to revoke`,
            }),
          );
        }

        yield* eventBus
          .publish([
            {
              id: "",
              recordedAt: now,
              type: "access.certificate_revoked",
              occurredAt: now,
              orgId: input.orgId,
              actorType: "person",
              actorId: row.personId,
              machineId: null,
              correlationId: input.certificateId,
              schemaVersion: 1,
              payload: { certificateId: input.certificateId, reason: input.reason },
            },
          ])
          .pipe(Effect.mapError((cause) => new SshCaError({ reason: "persist_failed", cause })));
      });

    const listCertificates = (
      orgId: string,
    ): Effect.Effect<ReadonlyArray<CertificateRow>, SshCaError> =>
      Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(certificates)
            .where(eq(certificates.orgId, orgId))
            .orderBy(desc(certificates.issuedAt)),
        catch: (cause) => new SshCaError({ reason: "persist_failed", cause }),
      }).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            personId: row.personId,
            machineScope: row.machineScope as MachineScope,
            fingerprint: row.fingerprint,
            issuedAt: row.issuedAt,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            revokedReason: row.revokedReason,
          })),
        ),
      );

    return { issueCertificate, revokeCertificate, listCertificates } as const;
  }),
}) {}
