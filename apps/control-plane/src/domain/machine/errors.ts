import { Schema } from "effect";
import { ulid } from "ulid";

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

const LockConflictSchema = Schema.Struct({
  packageName: Schema.String,
  lockedAtScope: Schema.Literal("org", "profile", "machine"),
  lockedAtScopeId: Schema.String,
  lockedVersionPin: Schema.NullOr(Schema.String),
});

/**
 * Overriding a locked manifest entry below its scope is a
 * validation error at edit time (HTTP 422), never a silent no-op.
 */
export class PackageLockConflictError extends Schema.TaggedError<PackageLockConflictError>(
  "PackageLockConflictError",
)("PackageLockConflictError", {
  error: Schema.Struct({
    code: Schema.Literal("locked_entry_conflict"),
    message: Schema.String,
    requestId: Schema.String,
    details: Schema.Struct({
      conflicts: Schema.Array(LockConflictSchema),
    }),
  }),
}) {}

/**
 * A package action the control plane declined to record (HTTP 422).
 *
 * Refusals, not failures: the machine was never asked. `baseline_package`
 * covers the deliberate refusal to install or remove anything the image
 * shipped with — uninstalling `systemd` through a button with no undo is not a
 * capability worth having. `already_pending` stops a second request stacking
 * up behind one the agent has not answered yet.
 */
export class PackageActionRejected extends Schema.TaggedError<PackageActionRejected>(
  "PackageActionRejected",
)("PackageActionRejected", {
  error: Schema.Struct({
    code: Schema.Literal(
      "invalid_package_name",
      "baseline_package",
      "already_pending",
      "write_failed",
      "reason_required",
      // Uninstalling a package set to Ensure: Cloudable would put it straight back.
      "ensured_package",
    ),
    message: Schema.String,
    requestId: Schema.String,
  }),
}) {}

/**
 * An edit whose *Ensure* setting cannot hold: the package is not one Cloudable
 * can install, or *Ensure latest version* is combined with a version pin.
 * HTTP 422, checked before anything is written or any approval is asked for.
 */
export class PackageEnsureSettingError extends Schema.TaggedError<PackageEnsureSettingError>(
  "PackageEnsureSettingError",
)("PackageEnsureSettingError", {
  error: Schema.Struct({
    code: Schema.Literal("invalid_ensure_setting"),
    message: Schema.String,
    requestId: Schema.String,
    details: Schema.Struct({
      problems: Schema.Array(
        Schema.Struct({
          packageName: Schema.String,
          reason: Schema.Literal(
            "not_installable",
            "ensure_latest_with_pin",
            "invalid_version_pin",
          ),
          message: Schema.String,
        }),
      ),
    }),
  }),
}) {}

export const ensureSettingError = (
  problems: ReadonlyArray<{
    packageName: string;
    reason: "not_installable" | "ensure_latest_with_pin" | "invalid_version_pin";
    message: string;
  }>,
): PackageEnsureSettingError =>
  new PackageEnsureSettingError({
    error: {
      code: "invalid_ensure_setting",
      message: problems.map((problem) => problem.message).join(" "),
      requestId: ulid(),
      details: { problems: [...problems] },
    },
  });
