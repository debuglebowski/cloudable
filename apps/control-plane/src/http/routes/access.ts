// ---------------------------------------------------------------------------
// `/api/v1/access/...` endpoint + schema definitions (SSH certificates,
// terminal/SSH sessions). Handlers live in `../handlers/access.ts`; this
// file only declares shapes, mirroring `packages/contracts/src/domains/access.ts`
// (the CLI's type-only view of the same wire shapes).
//
// No path parameters: certificate/session ids travel in the JSON body
// (`revoke`/`end` take `{ certificateId | sessionId, ... }`) rather than
// `/:id` segments — a deliberate simplification for this build.
//
// `issueCertificate`/`listCertificates`/`revokeCertificate`/`endSession`/
// `listSessions` still take `orgId`/`personId` explicitly rather than via
// `CurrentUserAuthentication`: `issueCertificate` is `cloudable login`'s CLI
// flow (`apps/cli/src/login.ts`), which has no browser session to carry at
// all — no real IdP exists yet, so it takes `--dev-person-id`/`--org-id`
// flags by design (see that file's own header comment); the other four
// aren't part of this — they just haven't needed migrating (`endSession`/
// `listSessions` don't gate on `personId` at all, and both scripts in this
// build share one fixed `orgId`, so that value is never actually wrong).
//
// `mintSession` IS `CurrentUserAuthentication`-gated (below): unlike the
// above, an attacker-supplied `personId` there is a real access-control
// bypass — `isAuthorizedForInteractiveAccess` (`../tunnel/access-
// authorization.ts`) decides "may this caller open a shell on this
// machine" by comparing `personId` against the machine's owner, so a wrong
// (or client-forgeable) `personId`/`idpIdentity` either wrongly denies the
// real owner or wrongly authorizes someone else entirely.
// ---------------------------------------------------------------------------
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { CurrentUserAuthentication } from "../middleware/auth";

export const MachineScope = Schema.Union(Schema.Literal("all"), Schema.Array(Schema.String));

// Four error shapes shared by every access endpoint, each chained onto every endpoint via
// its own `.addError(schema, { status })` call below (one call per variant — a single
// `Schema.Union` with per-member status annotations doesn't thread through this version of
// `@effect/platform`'s `addError`).
export const NotFoundError = Schema.Struct({
  code: Schema.Literal("not_found"),
  message: Schema.String,
});
export const DeniedError = Schema.Struct({
  code: Schema.Literal("denied"),
  message: Schema.String,
});
export const BadRequestError = Schema.Struct({
  code: Schema.Literal("bad_request"),
  message: Schema.String,
});
export const InternalError = Schema.Struct({
  code: Schema.Literal("internal_error"),
  message: Schema.String,
});

const IssueCertificateRequest = Schema.Struct({
  orgId: Schema.String,
  personId: Schema.String,
  osUser: Schema.String,
  machineScope: MachineScope,
  publicKeyBase64: Schema.String,
});

const IssueCertificateResponse = Schema.Struct({
  certificateId: Schema.String,
  certificate: Schema.String,
  fingerprint: Schema.String,
  expiresAt: Schema.String,
});

const CertificateSummary = Schema.Struct({
  id: Schema.String,
  personId: Schema.String,
  machineScope: MachineScope,
  fingerprint: Schema.String,
  issuedAt: Schema.String,
  expiresAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  revokedReason: Schema.NullOr(Schema.String),
});

const ListCertificatesUrlParams = Schema.Struct({ orgId: Schema.String });
const ListCertificatesResponse = Schema.Struct({ certificates: Schema.Array(CertificateSummary) });

const RevokeCertificateRequest = Schema.Struct({
  orgId: Schema.String,
  certificateId: Schema.String,
  reason: Schema.String,
});

const MintSessionTokenRequest = Schema.Struct({
  targetMachineId: Schema.String,
  targetOsUser: Schema.String,
  method: Schema.Literal("terminal", "ssh"),
});

const MintSessionTokenResponse = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  expiresAt: Schema.String,
});

const EndSessionRequest = Schema.Struct({ orgId: Schema.String, sessionId: Schema.String });

const ListSessionsUrlParams = Schema.Struct({ orgId: Schema.String });
const SessionSummary = Schema.Struct({
  id: Schema.String,
  machineId: Schema.String,
  machineName: Schema.String,
  personId: Schema.String,
  method: Schema.Literal("terminal", "ssh"),
  osUser: Schema.String,
  startedAt: Schema.String,
});
const ListSessionsResponse = Schema.Struct({ sessions: Schema.Array(SessionSummary) });

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

// Response for `GET /api/v1/access/session-token-public-key` — wraps
// `Signer.publicKey(SESSION_TOKEN_KEY_ID)`. Not secret: only the PUBLIC half
// of the signing key, so the agent can fetch and cache it with no
// auth/secret involved and validate a session token's signature locally
// before attaching.
const SessionTokenPublicKeyResponse = Schema.Struct({
  keyId: Schema.String,
  publicKeyDerBase64: Schema.String,
});

export const AccessGroup = HttpApiGroup.make("access")
  .add(
    HttpApiEndpoint.post("issueCertificate", "/api/v1/access/certificates")
      .setPayload(IssueCertificateRequest)
      .addSuccess(IssueCertificateResponse)
      .addError(NotFoundError, { status: 404 })
      .addError(DeniedError, { status: 403 })
      .addError(BadRequestError, { status: 400 })
      .addError(InternalError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("listCertificates", "/api/v1/access/certificates")
      .setUrlParams(ListCertificatesUrlParams)
      .addSuccess(ListCertificatesResponse)
      .addError(NotFoundError, { status: 404 })
      .addError(DeniedError, { status: 403 })
      .addError(BadRequestError, { status: 400 })
      .addError(InternalError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("revokeCertificate", "/api/v1/access/certificates/revoke")
      .setPayload(RevokeCertificateRequest)
      .addSuccess(Ok)
      .addError(NotFoundError, { status: 404 })
      .addError(DeniedError, { status: 403 })
      .addError(BadRequestError, { status: 400 })
      .addError(InternalError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("mintSession", "/api/v1/access/sessions")
      .setPayload(MintSessionTokenRequest)
      .addSuccess(MintSessionTokenResponse)
      .addError(NotFoundError, { status: 404 })
      .addError(DeniedError, { status: 403 })
      .addError(BadRequestError, { status: 400 })
      .addError(InternalError, { status: 500 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.post("endSession", "/api/v1/access/sessions/end")
      .setPayload(EndSessionRequest)
      .addSuccess(Ok)
      .addError(NotFoundError, { status: 404 })
      .addError(DeniedError, { status: 403 })
      .addError(BadRequestError, { status: 400 })
      .addError(InternalError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("listSessions", "/api/v1/access/sessions")
      .setUrlParams(ListSessionsUrlParams)
      .addSuccess(ListSessionsResponse)
      .addError(InternalError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("sessionTokenPublicKey", "/api/v1/access/session-token-public-key")
      .addSuccess(SessionTokenPublicKeyResponse)
      .addError(InternalError, { status: 500 }),
  );
