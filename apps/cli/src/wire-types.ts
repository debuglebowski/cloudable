// Type-only re-exports of the narrow wire surface this CLI uses.
// Feature units add specific type re-exports here as contracts/event domain files are
// created. Kept type-only (`export type`) so nothing is pulled into the compiled binary.
export type { PageInfo, ApiErrorBody } from "@cloudable/contracts";
