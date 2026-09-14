// Type-only re-exports of the narrow wire surface this daemon uses.
// Kept type-only (`export type`) so nothing is pulled into the compiled
// binary — same convention as `apps/agent/src/wire-types.ts`.
export type { PageInfo, ApiErrorBody } from "@cloudable/contracts";

// Attestation — the tunnel daemon is "just another attested machine
// identity" and calls the exact same `POST /api/v1/agent/attest` the control
// agent does. No new attestation method or endpoint for this daemon.
export type { AttestMethod, AttestRequest, AttestResponse } from "@cloudable/contracts";

// Tunnel-daemon-specific: the session-token signer's public key
// (`GET /api/v1/tunnel/session-token-key`) and the relay wire envelope.
export type { SessionTokenPublicKeyResponse, TunnelFrame } from "@cloudable/contracts";

// File sessions (`method: "files"`) — the operation/result shapes carried inside the
// `fs_request`/`fs_response` frames, plus the size limits the helper enforces. Values,
// not just types, for the limits: `fs-helper.ts` compares against them at runtime, and a
// second copy of "1 MiB" on the machine that disagreed with the browser's idea of it
// would show as an editor that offers to open files it cannot save.
export type { FsEntry, FsEntryType, FsFailureReason, FsOp, FsResult } from "@cloudable/contracts";
export {
  FS_CHUNK_BYTES,
  FS_MAX_ENTRIES,
  FS_MAX_INLINE_BYTES,
  FS_MAX_TRANSFER_BYTES,
} from "@cloudable/contracts";
