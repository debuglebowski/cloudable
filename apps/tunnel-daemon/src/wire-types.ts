// Type-only re-exports of the narrow wire surface this daemon uses.
// Kept type-only (`export type`) so nothing is pulled into the compiled
// binary — same convention as `apps/agent/src/wire-types.ts`.
export type { PageInfo, ApiErrorBody } from "@cloudable/contracts";

// Attestation (spec §9) — the tunnel daemon is "just another attested machine
// identity" and calls the exact same `POST /api/v1/agent/attest` the control
// agent does. No new attestation method or endpoint for this daemon.
export type { AttestMethod, AttestRequest, AttestResponse } from "@cloudable/contracts";

// Tunnel-daemon-specific: the session-token signer's public key
// (`GET /api/v1/tunnel/session-token-key`) and the relay wire envelope.
export type { SessionTokenPublicKeyResponse, TunnelFrame } from "@cloudable/contracts";
