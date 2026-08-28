import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import { OffboardingError, offboardPersonDetailed } from "../../domain/offboarding";
import { Api } from "../api";

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

export const OffboardingHttpLive = HttpApiBuilder.group(Api, "offboarding", (handlers) =>
  handlers.handle("offboardPerson", ({ payload }) =>
    offboardPersonDetailed(payload.personId, payload.requestedByPersonId, payload.reason).pipe(
      Effect.map((outcome) => ({
        ...outcome,
        machineFailures: outcome.machineFailures.map((f) => ({
          machineId: f.machineId,
          reason: describeError(f.cause),
        })),
      })),
      Effect.catchAll((error) => {
        const status =
          error instanceof OffboardingError && error.reason === "person_not_found" ? 404 : 500;
        const code =
          error instanceof OffboardingError && error.reason === "person_not_found"
            ? "person_not_found"
            : "internal_error";
        return HttpServerResponse.json(
          { error: { code, message: describeError(error), requestId: ulid() } },
          { status },
        ).pipe(Effect.orDie);
      }),
    ),
  ),
);
