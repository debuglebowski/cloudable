import { Schema } from "effect";

/**
 * Any unexpected database failure on the notifications read/write side.
 * Modeled as `Schema.TaggedError`, same convention as `../elevation/types.ts`'s
 * `ElevationInfraError` — one class usable both as an `Effect`-native tagged
 * error and as an HTTP error schema (`HttpApiEndpoint.addError`).
 */
export class NotificationInfraError extends Schema.TaggedError<NotificationInfraError>()(
  "NotificationInfraError",
  { reason: Schema.String },
) {}
