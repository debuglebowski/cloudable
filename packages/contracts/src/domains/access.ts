/**
 * Wire types for `/api/v1/access/...` (SSH certificates + terminal/SSH
 * sessions). See `docs/access.md` for the full flow.
 *
 * No real auth middleware exists yet (see `apps/control-plane/src/http/middleware/auth.ts`),
 * so every request below carries `personId` explicitly rather than deriving it from a
 * session — a future feature unit that wires `CurrentUserTag` up to these endpoints should
 * drop the field from the request body and read it from the authenticated context instead.
 */

/** Which machines a certificate or session grant is scoped to. */
export type MachineScope = "all" | ReadonlyArray<string>;

export interface IssueCertificateRequest {
  orgId: string;
  personId: string;
  /** OS username the certificate is valid for — the certificate's sole principal. */
  osUser: string;
  machineScope: MachineScope;
  /**
   * Base64 of the raw 32-byte Ed25519 public key point of the ephemeral
   * keypair `cloudable login` generated locally. The control plane never
   * generates or holds a user's private key — it only ever signs a public
   * key it is handed (CLAUDE.md invariant #9).
   */
  publicKeyBase64: string;
}

export interface IssueCertificateResponse {
  certificateId: string;
  /** `<cert-key-type> <base64> <comment>` — ready to write to an OpenSSH `known_hosts`/agent. */
  certificate: string;
  fingerprint: string;
  expiresAt: string;
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
  orgId: string;
  certificateId: string;
  reason: string;
}

export interface MintSessionTokenRequest {
  orgId: string;
  personId: string;
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: "terminal" | "ssh";
}

export interface MintSessionTokenResponse {
  sessionId: string;
  /** Opaque signed token — see `apps/control-plane/src/tunnel/session-token.ts`. */
  token: string;
  expiresAt: string;
}

export interface EndSessionRequest {
  orgId: string;
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
 * agent needs to validate a session token's signature before attaching
 * (spec §11.1) — CLAUDE.md invariant #9 is about the private key, never
 * entering the control plane beyond the `Signer` port; this response never
 * carries private key material at all.
 */
export interface SessionTokenPublicKeyResponse {
  keyId: string;
  /** Base64 of the SPKI DER-encoded Ed25519 public key. */
  publicKeyDerBase64: string;
}
