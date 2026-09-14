/**
 * Wire types for `/api/v1/access/...` (SSH certificates + terminal/SSH
 * sessions). See `docs/access.md` for the full flow.
 *
 * Every request below is real-session-scoped (`CurrentUserTag`, see
 * `apps/control-plane/src/http/middleware/auth.ts`) EXCEPT
 * `IssueCertificateRequest`: `issueCertificate` is `cloudable login`'s CLI
 * flow, which has no browser session to carry — it instead sends `code`, a
 * short-lived signed token minted by the console's session-gated
 * `POST /api/v1/cli-auth/code` and handed over via a local redirect (see
 * that endpoint's own doc comment in `apps/control-plane/src/http/routes/
 * access.ts`).
 */

/** Which machines a certificate or session grant is scoped to. */
export type MachineScope = "all" | ReadonlyArray<string>;

export interface IssueCertificateRequest {
  /** From `POST /api/v1/cli-auth/code` — carries `{ personId, orgId }`, verified server-side, never trusted from the client directly. */
  code: string;
  /** OS username the certificate is valid for — the certificate's sole principal. */
  osUser: string;
  machineScope: MachineScope;
  /**
   * Base64 of the raw 32-byte Ed25519 public key point of the ephemeral
   * keypair `cloudable login` generated locally. The control plane never
   * generates or holds a user's private key — it only ever signs a public
   * key it is handed.
   */
  publicKeyBase64: string;
}

export interface IssueCertificateResponse {
  certificateId: string;
  /** `<cert-key-type> <base64> <comment>` — ready to write to an OpenSSH `known_hosts`/agent. */
  certificate: string;
  fingerprint: string;
  expiresAt: string;
  /**
   * The CLI's API credential, sent as `Authorization: Bearer` on every other
   * `cloudable` command (see `apps/control-plane/src/services/CliToken.ts`).
   * Returned here so one browser sign-in yields both credentials: the
   * certificate gets you onto a machine over SSH, this gets you into the API.
   */
  token: string;
  /** When `token` stops being accepted. Much longer than `expiresAt` — a bearer token is re-checked against the live `people` row on every call, an SSH certificate is checked by nothing once issued. */
  tokenExpiresAt: string;
}

export interface CertificateSummary {
  id: string;
  personId: string;
  machineScope: MachineScope;
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface ListCertificatesResponse {
  certificates: ReadonlyArray<CertificateSummary>;
}

export interface RevokeCertificateRequest {
  certificateId: string;
  reason: string;
}

/**
 * The kinds of session `sessions.method` records and the tunnel can carry.
 *
 * `"files"` is deliberately its own method rather than a mode of `"terminal"`: it is
 * separately disablable (`AccessMethodsEnabled`), it is satisfied by a lower elevation
 * level for a machine you don't own (`file_recovery` as well as `shell`), and the signed
 * session token carries it as a claim the machine enforces — a token minted for files
 * cannot open a shell. Folding it into `"terminal"` would erase all three.
 *
 * Mirrored by `@cloudable/session-token`'s own `SessionMethod` (the daemon can't depend on
 * this package) and by the `method` payload field on `access.session_*` in
 * `@cloudable/events`. All three must be widened together.
 */
export type SessionMethod = "terminal" | "ssh" | "files";

export interface MintSessionTokenRequest {
  targetMachineId: string;
  method: SessionMethod;
}

export interface MintSessionTokenResponse {
  sessionId: string;
  /** Opaque signed token — see `apps/control-plane/src/tunnel/session-token.ts`. */
  token: string;
  expiresAt: string;
}

export interface EndSessionRequest {
  sessionId: string;
}

/** A single, uniformly-shaped error body for every `/api/v1/access/...` endpoint — see `http/routes/access.ts`. */
export interface AccessApiErrorBody {
  code: "not_found" | "denied" | "bad_request" | "internal_error";
  message: string;
}

/**
 * `GET /api/v1/access/session-token-public-key` response. Wraps
 * `Signer.publicKey(SESSION_TOKEN_KEY_ID)` — see
 * `apps/control-plane/src/tunnel/session-token.ts`. Not secret: this is the
 * PUBLIC half of the session-token signing key, which is exactly what the
 * agent needs to validate a session token's signature before attaching.
 * The private key never enters the control plane beyond the `Signer` port;
 * this response never carries private key material at all.
 */
export interface SessionTokenPublicKeyResponse {
  keyId: string;
  /** Base64 of the SPKI DER-encoded Ed25519 public key. */
  publicKeyDerBase64: string;
}
