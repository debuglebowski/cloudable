import { Data } from "effect";

/**
 * Errors from the offboarding orchestration itself. Sub-service failures
 * (approval, certificate revocation, provisioning, archive, repo) are all
 * wrapped into this single tagged error with their original cause
 * preserved, so `offboardPerson`'s error channel stays simple for callers
 * (the HTTP handler, tests) while nothing about the underlying failure is
 * lost.
 */
export class OffboardingError extends Data.TaggedError("OffboardingError")<{
  reason: "person_not_found" | "sub_operation_failed";
  cause?: unknown;
}> {}
