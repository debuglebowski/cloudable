// Type-only re-exports of the narrow wire surface this agent uses.
// Feature units (attestation, poll/report/wake) add specific type re-exports here as those
// contracts/event domain files are created. Kept type-only (`export type`) so nothing is
// pulled into the compiled binary.
export type { PageInfo, ApiErrorBody } from "@cloudable/contracts";

// Agent protocol (attest/poll/report/wake) — see docs/agents.md and
// apps/control-plane/src/http/routes/agent-protocol.ts for the server side.
export type {
  AttestMethod,
  AttestRequest,
  AttestResponse,
  DesiredStateResponse,
  AgentReportRequest,
  AgentReportResponse,
  WakeMessage,
} from "@cloudable/contracts";

// Tunnel / session-token verification (spec §11.1) — see docs/access.md §4.
// Consumed by `./tunnel/session-token-verify.ts`'s `getSessionTokenPublicKey`,
// fetched from `GET /api/v1/access/session-token-public-key`.
export type { SessionTokenPublicKeyResponse } from "@cloudable/contracts";
