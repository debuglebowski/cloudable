import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { SshCaService } from "../../services/ssh-ca/SshCaService";
import { TunnelServer } from "../../tunnel/server";
import { Api } from "../api";

type AccessErrorBody =
  | { code: "not_found"; message: string }
  | { code: "denied"; message: string }
  | { code: "bad_request"; message: string }
  | { code: "internal_error"; message: string };

const toAccessError = (reason: string, message: string): AccessErrorBody => {
  switch (reason) {
    case "not_found":
      return { code: "not_found", message };
    case "denied":
      return { code: "denied", message };
    case "invalid_public_key":
    case "malformed":
      return { code: "bad_request", message };
    default:
      return { code: "internal_error", message };
  }
};

/** Maps a tagged domain error (`SshCaError` | `TunnelError` | `SignerError`, all shaped `{ reason, cause? }`) onto the shared `AccessApiError` union. */
const asAccessError = <E extends { reason: string; cause?: unknown; detail?: string }>(
  error: E,
): AccessErrorBody =>
  toAccessError(error.reason, error.detail ?? String(error.cause ?? error.reason));

export const AccessLive = HttpApiBuilder.group(Api, "access", (handlers) =>
  handlers
    .handle("issueCertificate", ({ payload }) =>
      Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        const subjectPublicKeyRaw = new Uint8Array(Buffer.from(payload.publicKeyBase64, "base64"));
        const issued = yield* sshCa.issueCertificate({
          orgId: payload.orgId,
          personId: payload.personId,
          osUser: payload.osUser,
          machineScope: payload.machineScope,
          subjectPublicKeyRaw,
        });
        return {
          certificateId: issued.certificateId,
          certificate: issued.certificate,
          fingerprint: issued.fingerprint,
          expiresAt: issued.expiresAt.toISOString(),
        };
      }).pipe(Effect.catchTag("SshCaError", (e) => Effect.fail(asAccessError(e)))),
    )
    .handle("listCertificates", ({ urlParams }) =>
      Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        const rows = yield* sshCa.listCertificates(urlParams.orgId);
        return {
          certificates: rows.map((row) => ({
            id: row.id,
            personId: row.personId,
            machineScope: row.machineScope,
            fingerprint: row.fingerprint,
            issuedAt: row.issuedAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
            revokedReason: row.revokedReason,
          })),
        };
      }).pipe(Effect.catchTag("SshCaError", (e) => Effect.fail(asAccessError(e)))),
    )
    .handle("revokeCertificate", ({ payload }) =>
      Effect.gen(function* () {
        const sshCa = yield* SshCaService;
        yield* sshCa.revokeCertificate({
          orgId: payload.orgId,
          certificateId: payload.certificateId,
          reason: payload.reason,
        });
        return { ok: true as const };
      }).pipe(Effect.catchTag("SshCaError", (e) => Effect.fail(asAccessError(e)))),
    )
    .handle("mintSession", ({ payload }) =>
      Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        const minted = yield* tunnel.mintSession({
          orgId: payload.orgId,
          personId: payload.personId,
          idpIdentity: payload.idpIdentity,
          targetMachineId: payload.targetMachineId,
          targetOsUser: payload.targetOsUser,
          method: payload.method,
        });
        return {
          sessionId: minted.sessionId,
          token: minted.token,
          expiresAt: minted.expiresAt.toISOString(),
        };
      }).pipe(Effect.catchTag("TunnelError", (e) => Effect.fail(asAccessError(e)))),
    )
    .handle("endSession", ({ payload }) =>
      Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        yield* tunnel.endSession({ orgId: payload.orgId, sessionId: payload.sessionId });
        return { ok: true as const };
      }).pipe(Effect.catchTag("TunnelError", (e) => Effect.fail(asAccessError(e)))),
    ),
);
