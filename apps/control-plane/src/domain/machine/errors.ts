import { Schema } from "effect";

/**
 * Typed HTTP errors for the machines API. Declared with `Schema.TaggedError`
 * so the same class is both the `MachineService`/domain failure type and the
 * `HttpApiEndpoint.addError` schema — no separate mapping layer between the
 * two. Fields nest under `error` to keep the wire shape consistent with
 * `@cloudable/contracts`' `ApiErrorBody`.
 */
export class MachineNotFoundError extends Schema.TaggedError<MachineNotFoundError>(
  "MachineNotFoundError",
)("MachineNotFoundError", {
  error: Schema.Struct({
    code: Schema.Literal("not_found"),
    message: Schema.String,
    requestId: Schema.String,
  }),
}) {}

/**
 * A create-machine request whose provider/region/image combination doesn't
 * hold — region supplied for a provider that has none, region missing for
 * one that requires it, or a region/image that isn't in the org's enabled
 * catalog. The dropdown already restricts the happy path client-side; this
 * is what stops a raw API call from bypassing it.
 */
export class InvalidMachineRequestError extends Schema.TaggedError<InvalidMachineRequestError>(
  "InvalidMachineRequestError",
)("InvalidMachineRequestError", {
  error: Schema.Struct({
    code: Schema.Literal("invalid_machine_request"),
    message: Schema.String,
    requestId: Schema.String,
  }),
}) {}

/** A malformed `cursor` query param on `GET /api/v1/machines` — a client input error, not an infra failure. */
export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>(
  "InvalidCursorError",
)("InvalidCursorError", {
  error: Schema.Struct({
    code: Schema.Literal("invalid_cursor"),
    message: Schema.String,
    requestId: Schema.String,
  }),
}) {}

/** Restart only makes sense for a live, running machine — a stopped, archived,
 * errored, or still-provisioning one has nothing to reboot. */
export class MachineNotRunningError extends Schema.TaggedError<MachineNotRunningError>(
  "MachineNotRunningError",
)("MachineNotRunningError", {
  error: Schema.Struct({
    code: Schema.Literal("machine_not_running"),
    message: Schema.String,
    requestId: Schema.String,
  }),
}) {}

const PinConflictSchema = Schema.Struct({
  packageName: Schema.String,
  pinnedAtScope: Schema.Literal("org", "template", "machine"),
  pinnedAtScopeId: Schema.String,
  pinnedVersionPin: Schema.NullOr(Schema.String),
});

/**
 * Overriding a pinned manifest entry below its scope is a
 * validation error at edit time (HTTP 422), never a silent no-op.
 */
export class PackagePinConflictError extends Schema.TaggedError<PackagePinConflictError>(
  "PackagePinConflictError",
)("PackagePinConflictError", {
  error: Schema.Struct({
    code: Schema.Literal("pinned_entry_conflict"),
    message: Schema.String,
    requestId: Schema.String,
    details: Schema.Struct({
      conflicts: Schema.Array(PinConflictSchema),
    }),
  }),
}) {}
