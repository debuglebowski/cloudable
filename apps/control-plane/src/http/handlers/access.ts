import { certificates, machines, people, sessions } from "@cloudable/schema";
import { HttpApiBuilder } from "@effect/platform";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { isAdmin } from "../../domain/authz";
import { ensureActivation } from "../../idp-roles/activation";
import { checkStanding, roleEvidenceDeadline } from "../../idp-roles/standing";
import { verifyCliAuthCode } from "../../services/CliAuthCode";
import { CLI_TOKEN_TTL_MS, issueCliToken } from "../../services/CliToken";
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

/**
 * The machines a certificate may name: only the person's own. An admin has no live access to
 * anyone else's machine either, so the rule is the same for everyone. `"all"` is narrowed to
 * the person's own machines at issue time, so the stored scope says what it really covers.
 */
const resolveCertificateScope = (
  personId: string,
  orgId: string,
  requested: "all" | ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const owned = yield* Effect.tryPromise(() =>
      db
        .select({ id: machines.id })
        .from(machines)
        .where(and(eq(machines.ownerPersonId, personId), eq(machines.orgId, orgId))),
    ).pipe(Effect.orDie);
    const ownedIds = owned.map((row) => row.id);
    if (requested === "all") return ownedIds;
    const notOwned = requested.filter((id) => !ownedIds.includes(id));
    if (notOwned.length > 0) {
      return yield* Effect.fail({
        code: "denied" as const,
        message: `A certificate can only name your own machines. Not yours: ${notOwned.join(", ")}.`,
      });
    }
    return requested;
  });

/**
 * The person's standing at the moment a CLI sign-in code is redeemed: the same check the API
 * applies to every console session and CLI token (`idp-roles/standing.ts`), with the code's own
 * issue time. So a code minted before the person was deactivated, before their credentials were
 * revoked (an email change, a refused SSO sign-in, the identity-provider mode switching on), or
 * once their role evidence is stale, mints nothing. Returns the role-evidence deadline when roles
 * come from the identity provider, which caps the certificate.
 */
const requirePersonStanding = (personId: string, codeIssuedAt: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const idpRoles = config.idpRoles;
    if (idpRoles !== null) yield* Effect.promise(() => ensureActivation(db, idpRoles));
    const rows = yield* Effect.tryPromise(() =>
      db
        .select({
          active: people.active,
          credentialsRevokedAt: people.credentialsRevokedAt,
          idpRolesVerifiedAt: people.idpRolesVerifiedAt,
        })
        .from(people)
        .where(eq(people.id, personId))
        .limit(1),
    ).pipe(Effect.orDie);
    const person = rows[0];
    const refusal = person
      ? checkStanding(person, codeIssuedAt, Date.now(), idpRoles)
      : "deactivated";
    switch (refusal) {
      case null:
        return person && idpRoles ? roleEvidenceDeadline(person, idpRoles) : null;
      case "deactivated":
        return yield* Effect.fail({
          code: "denied" as const,
          message: "This person is deactivated. Ask an org admin.",
        });
      case "credentials_revoked":
        return yield* Effect.fail({
          code: "denied" as const,
          message:
            "This sign-in code was issued before your credentials were revoked. Run `cloudable login` again.",
        });
      case "idp_reauthentication_required":
        return yield* Effect.fail({
          code: "denied" as const,
          message:
            "Your role must be confirmed by your identity provider again. Run `cloudable login` to sign in through SSO.",
        });
    }
  });

export const AccessLive = HttpApiBuilder.group(Api, "access", (handlers) =>
  handlers
    .handle("issueCertificate", ({ payload }) =>
      Effect.gen(function* () {
        // `code` came from `POST /api/v1/cli-auth/code` (session-gated,
        // called by the console's `/cli-auth` page) via a local redirect to
        // `cloudable login`'s own callback server — see that route's header
        // comment. Verified here, never trusted from the request body
        // directly.
        const verified = verifyCliAuthCode(payload.code);
        if (!verified.ok) {
          return yield* Effect.fail({
            code: "denied" as const,
            message: `Sign-in code ${verified.error.reason} — run \`cloudable login\` again.`,
          });
        }

        const roleEvidenceEnds = yield* requirePersonStanding(verified.personId, verified.issuedAt);
        const machineScope = yield* resolveCertificateScope(
          verified.personId,
          verified.orgId,
          payload.machineScope,
        );

        const sshCa = yield* SshCaService;
        const subjectPublicKeyRaw = new Uint8Array(Buffer.from(payload.publicKeyBase64, "base64"));
        const issued = yield* sshCa.issueCertificate({
          orgId: verified.orgId,
          personId: verified.personId,
          osUser: payload.osUser,
          machineScope,
          subjectPublicKeyRaw,
          notAfter: roleEvidenceEnds ?? undefined,
        });
        // One sign-in, both credentials. The certificate is for sshd on the
        // machine, which verifies it offline; the token is for this API,
        // which re-checks the person on every call. See `CliToken.ts` for
        // why the CLI no longer signs in with a password of its own.
        return {
          certificateId: issued.certificateId,
          certificate: issued.certificate,
          fingerprint: issued.fingerprint,
          expiresAt: issued.expiresAt.toISOString(),
          token: issueCliToken({ personId: verified.personId }),
          tokenExpiresAt: new Date(Date.now() + CLI_TOKEN_TTL_MS).toISOString(),
        };
      }).pipe(Effect.catchTag("SshCaError", (e) => Effect.fail(asAccessError(e)))),
    )
    .handle("listCertificates", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const sshCa = yield* SshCaService;
        const all = yield* sshCa.listCertificates(currentUser.orgId);
        // A member sees their own certificates. An admin sees the org's.
        const rows = isAdmin(currentUser)
          ? all
          : all.filter((row) => row.personId === currentUser.personId);
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
        const currentUser = yield* CurrentUserTag;
        if (!isAdmin(currentUser)) {
          // Not yours: the same not-found as a certificate that does not exist.
          const db = yield* Db;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({ personId: certificates.personId })
              .from(certificates)
              .where(
                and(
                  eq(certificates.id, payload.certificateId),
                  eq(certificates.orgId, currentUser.orgId),
                ),
              )
              .limit(1),
          ).pipe(Effect.orDie);
          if (rows[0]?.personId !== currentUser.personId) {
            return yield* Effect.fail({
              code: "not_found" as const,
              message: `no certificate ${payload.certificateId}`,
            });
          }
        }
        const sshCa = yield* SshCaService;
        yield* sshCa.revokeCertificate({
          orgId: currentUser.orgId,
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
        const currentUser = yield* CurrentUserTag;
        if (!isAdmin(currentUser)) {
          const db = yield* Db;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({ personId: sessions.personId })
              .from(sessions)
              .where(and(eq(sessions.id, payload.sessionId), eq(sessions.orgId, currentUser.orgId)))
              .limit(1),
          ).pipe(Effect.orDie);
          if (rows[0]?.personId !== currentUser.personId) {
            return yield* Effect.fail({
              code: "not_found" as const,
              message: `no live session ${payload.sessionId}`,
            });
          }
        }
        const tunnel = yield* TunnelServer;
        yield* tunnel.endSession({ orgId: currentUser.orgId, sessionId: payload.sessionId });
        return { ok: true as const };
      }).pipe(Effect.catchTag("TunnelError", (e) => Effect.fail(asAccessError(e)))),
    )
    .handle("listSessions", () =>
      Effect.flatMap(CurrentUserTag, (currentUser) =>
        listActiveSessionsByOrg(currentUser.orgId).pipe(
          Effect.map((rows) =>
            isAdmin(currentUser)
              ? rows
              : rows.filter((row) => row.personId === currentUser.personId),
          ),
        ),
      ).pipe(
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
