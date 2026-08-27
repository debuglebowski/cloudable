import { Schema } from "effect";

/**
 * Domain errors for the config editor + GitOps path (docs/spec.md §16).
 * Each is a `Schema.TaggedError` so it can be attached directly to an
 * `HttpApiEndpoint` via `.addError(SomeError, { status })` — the same class
 * is both the Effect failure type and the wire error schema.
 */

/** `POST /config/machines/:id/reconcile` was called without `{ confirm: true }`. */
export class ConfirmationRequiredError extends Schema.TaggedError<ConfirmationRequiredError>(
  "ConfirmationRequiredError",
)("ConfirmationRequiredError", {
  message: Schema.String,
}) {}

/** The target machine does not exist, or does not belong to the given org. */
export class MachineNotFoundError extends Schema.TaggedError<MachineNotFoundError>(
  "MachineNotFoundError",
)("MachineNotFoundError", {
  machineId: Schema.String,
}) {}

/**
 * A machine (or template) tried to override a package-manifest entry that
 * is pinned at a level above it (docs/spec.md §6: "Attempting to override
 * one is a validation error at edit time, not a silent no-op at reconcile").
 */
export class PinnedSettingError extends Schema.TaggedError<PinnedSettingError>(
  "PinnedSettingError",
)("PinnedSettingError", {
  key: Schema.String,
  pinnedAtScopeType: Schema.String,
  pinnedAtScopeId: Schema.String,
}) {}

/** The request shape is internally inconsistent (e.g. org-scope edit whose `scopeId` isn't `orgId`). */
export class InvalidScopeError extends Schema.TaggedError<InvalidScopeError>("InvalidScopeError")(
  "InvalidScopeError",
  {
    message: Schema.String,
  },
) {}

/** An unexpected failure writing to the database or publishing the resulting event. */
export class SettingWriteError extends Schema.TaggedError<SettingWriteError>("SettingWriteError")(
  "SettingWriteError",
  {
    message: Schema.String,
  },
) {}
