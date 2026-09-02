import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { SignerTag } from "../../services/Signer";
import { SshCaService } from "../../services/ssh-ca/SshCaService";
import { listActiveSessionsByOrg } from "../../tunnel/queries";
import { TunnelServer } from "../../tunnel/server";
import { SESSION_TOKEN_KEY_ID } from "../../tunnel/session-token";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

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
        const currentUser = yield* CurrentUserTag;
        const tunnel = yield* TunnelServer;
        const minted = yield* tunnel.mintSession({
          orgId: currentUser.orgId,
          personId: currentUser.personId,
          idpIdentity: currentUser.email,
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
    )
    .handle("listSessions", ({ urlParams }) =>
      listActiveSessionsByOrg(urlParams.orgId).pipe(
        Effect.map((rows) => ({
          sessions: rows.map((row) => ({
            id: row.id,
            machineId: row.machineId,
            machineName: row.machineName,
            personId: row.personId,
            method: row.method,
            osUser: row.osUser,
            startedAt: row.startedAt.toISOString(),
          })),
        })),
        Effect.catchTag("SessionQueryError", (e) =>
          Effect.fail({ code: "internal_error" as const, message: e.reason }),
        ),
      ),
    )
    .handle("sessionTokenPublicKey", () =>
      Effect.gen(function* () {
        const signer = yield* SignerTag;
        const publicKeyDer = yield* signer.publicKey(SESSION_TOKEN_KEY_ID);
        return {
          keyId: SESSION_TOKEN_KEY_ID,
          publicKeyDerBase64: Buffer.from(publicKeyDer).toString("base64"),
        };
      }).pipe(
        // Only `InternalError` is declared on this endpoint (see routes/access.ts) — unlike
        // `asAccessError`, which maps the full `SignerError` reason space onto all four access
        // error codes, `Signer.publicKey` for a fixed, well-known `keyId` never plausibly fails
        // with `not_found`/`denied`/`bad_request`, so this narrows explicitly instead.
        //
        // Deliberately a fixed, generic message rather than `e.cause`/`e.reason` verbatim: this
        // endpoint takes no `orgId`/auth at all (by design — see routes/access.ts's comment on
        // why the public key needs none), so unlike every other access handler here, its error
        // body is reachable by literally anyone. `Signer.azure.ts`'s stub failure message
        // ("no Azure Key Vault account configured in this build") is harmless today only because
        // `LocalSignerLive` is always wired in this build — it must not leak infra detail once a
        // real Azure-backed `Signer` is live.
        Effect.catchTag("SignerError", () =>
          Effect.fail({
            code: "internal_error" as const,
            message: "failed to retrieve the session-token public key",
          }),
        ),
      ),
    ),
);
