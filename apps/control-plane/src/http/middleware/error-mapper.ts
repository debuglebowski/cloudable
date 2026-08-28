import type { ApiErrorBody } from "@cloudable/contracts";
import { HttpServerResponse } from "@effect/platform";
import type { HttpBodyError } from "@effect/platform/HttpBody";
import type { Effect } from "effect";

/**
 * Placeholder error mapper: collapses any error to a 500 with a well-formed
 * `ApiErrorBody`. Feature units extend this as real domain errors
 * (validation, not-found, forbidden, conflict, etc.) are introduced and
 * need their own status codes.
 */
export const mapErrorToResponse = (
  error: unknown,
  requestId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBodyError> => {
  const body: ApiErrorBody = {
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "An unexpected error occurred.",
      requestId,
    },
  };
  return HttpServerResponse.json(body, { status: 500 });
};
