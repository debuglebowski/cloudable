import { Effect } from "effect";
import { type AttestationMethod, AttestationError } from "./AttestationMethod";

// ---------------------------------------------------------------------------
// STUB. Unit 3 owns the real `join_token` `AttestationMethod` (admin-issued
// join tokens — docs/spec.md §9: "first-class, not a fallback. Build
// first."). This file exists only so the `/attest` endpoint's `method`
// dispatch has both branches wired end-to-end for this unit's own tests and
// the E2E curl check: every call fails with `not_implemented`, mirroring the
// existing `ApprovalService` stub pattern in this codebase.
//
// Reconciliation: delete this file and drop it from `registry.ts`'s array
// once unit 3's real join-token implementation lands. If unit 3's PR is
// already merged by the time this one is reviewed, extend that file's
// handler/dispatch logic instead of adding this stub at all — see this
// unit's brief, "Cross-unit dependency note".
// ---------------------------------------------------------------------------
const notImplemented = Effect.fail(
  new AttestationError({ reason: "not_implemented", cause: "unit 3 (join-token attestation) has not landed yet" }),
);

export const joinTokenAttestationStub: AttestationMethod = {
  method: "join_token",
  issueCredential: () => notImplemented,
  verifyCredential: () => notImplemented,
};
