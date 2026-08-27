// Type-only re-exports of the narrow wire surface this agent uses.
// Feature units (attestation, poll/report/wake) add specific type re-exports here as those
// contracts/event domain files are created. Kept type-only (`export type`) so nothing is
// pulled into the compiled binary.
export type { PageInfo, ApiErrorBody } from "@cloudable/contracts";
export type { AttestMethod, AttestRequest, AttestResponse } from "@cloudable/contracts";
