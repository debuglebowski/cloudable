import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import {
  OffboardingError,
  OffboardingRepoTag,
  offboardPersonDetailed,
  resumeOffboarding,
} from "../../domain/offboarding";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

/**
 * `OffboardingError`'s tagged-error `cause` carries the real diagnostic —
 * its inherited `.message` is always empty (`Data.TaggedError` doesn't set
 * one), so the shared `mapErrorToResponse` placeholder (which reads
 * `.message`) would report an empty string here. Building the message from
 * `reason`/`cause` directly, scoped to this handler, avoids that without
 * touching the shared placeholder.
 */
function describeError(error: unknown): string {
  if (error instanceof OffboardingError) {
    const causeText =
      error.cause instanceof Error
        ? error.cause.message
        : (JSON.stringify(error.cause) ?? String(error.cause));
    return `Offboarding failed (${error.reason}): ${causeText}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `person_not_found` and `invalid_approval` are both "nothing here for you to
 * see" from the caller's point of view (an approval belonging to a different
 * org resolves to `invalid_approval` too — see `ApprovalService.status`'s own
 * non-leaking `not_found` — never a distinguishable "wrong org" response). */
function statusAndCodeFor(error: unknown): { status: number; code: string } {
  if (error instanceof OffboardingError) {
    if (error.reason === "person_not_found" || error.reason === "invalid_approval") {
      return { status: 404, code: error.reason };
    }
  }
  return { status: 500, code: "internal_error" };
}

const toWireOutcome = <A extends { machineFailures: { machineId: string; cause: unknown }[] }>(
  outcome: A,
) => ({
  ...outcome,
  machineFailures: outcome.machineFailures.map((f) => ({
    machineId: f.machineId,
    reason: describeError(f.cause),
  })),
});

const toErrorResponse = (error: unknown) => {
  const { status, code } = statusAndCodeFor(error);
  return HttpServerResponse.json(
    { error: { code, message: describeError(error), requestId: ulid() } },
    { status },
  ).pipe(Effect.orDie);
};

export const OffboardingHttpLive = HttpApiBuilder.group(Api, "offboarding", (handlers) =>
  handlers
    .handle("offboardPerson", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // `offboardPersonDetailed`'s own signature is the exact one the spec
        // describes (see `domain/offboarding/offboardPerson.ts`) and doesn't
        // take an `orgId` — this scoped lookup is the tenant-ownership gate
        // in front of it, same reasoning as `archive`'s handlers. A person
        // in a DIFFERENT org is `person_not_found`, not a separate case —
        // never confirm another org's person exists.
        const repo = yield* OffboardingRepoTag;
        const person = yield* repo
          .findPerson(payload.personId)
          .pipe(
            Effect.mapError(
              (cause) => new OffboardingError({ reason: "sub_operation_failed", cause }),
            ),
          );
        if (!person || person.orgId !== currentUser.orgId) {
          return yield* Effect.fail(
            new OffboardingError({ reason: "person_not_found", cause: payload.personId }),
          );
        }
        return yield* offboardPersonDetailed(
          payload.personId,
          currentUser.personId,
          payload.reason,
        );
      }).pipe(Effect.map(toWireOutcome), Effect.catchAll(toErrorResponse)),
    )
    .handle("sync", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // `resumeOffboarding` scopes its own lookup to `orgId` (see
        // `ApprovalService.status`) — an approval belonging to a different
        // org, or one that isn't an offboarding approval, comes back as
        // `invalid_approval`, the same non-leaking shape as everywhere else.
        return yield* resumeOffboarding(path.approvalId, currentUser.orgId);
      }).pipe(Effect.map(toWireOutcome), Effect.catchAll(toErrorResponse)),
    ),
);
