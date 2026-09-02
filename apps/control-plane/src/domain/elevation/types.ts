import type { elevations } from "@cloudable/schema";
import { Schema } from "effect";

/** The elevation row shape, inferred straight from the Drizzle table — see `packages/schema/src/tables/elevation.ts`. */
export type Elevation = typeof elevations.$inferSelect;

export type ElevationLevel = Elevation["level"];
export type ElevationStatus = Elevation["status"];

/** Org policy for an admin connecting to a machine they do not own. */
export type AdminAccessPolicy = "never" | "always" | "with_approval";

/** Approval mode — resolved generically per action type via `resolveSetting`. */
export type ApprovalMode = "none" | "single" | "dual";

export interface RequestElevationInput {
  personId: string;
  machineId: string;
  level: ElevationLevel;
  reason: string;
}

/**
 * Domain errors for the elevation flow. Modeled as `Schema.TaggedError` so
 * the same class works both as an `Effect`-native tagged error inside
 * domain logic (`Effect.fail(new X({...}))`) and as an HTTP error schema
 * (`HttpApiEndpoint.addError(X, { status })`) without duplicating the shape.
 */
export class ElevationValidationError extends Schema.TaggedError<ElevationValidationError>()(
  "ElevationValidationError",
  { reason: Schema.String },
) {}

export class MachineNotFoundError extends Schema.TaggedError<MachineNotFoundError>()(
  "MachineNotFoundError",
  { machineId: Schema.String },
) {}

export class PersonNotFoundError extends Schema.TaggedError<PersonNotFoundError>()(
  "PersonNotFoundError",
  { personId: Schema.String },
) {}

export class ElevationNotFoundError extends Schema.TaggedError<ElevationNotFoundError>()(
  "ElevationNotFoundError",
  { elevationId: Schema.String },
) {}

/** The requester already owns the machine — this whole flow is for admin access to machines you don't own. */
export class SelfOwnedMachineError extends Schema.TaggedError<SelfOwnedMachineError>()(
  "SelfOwnedMachineError",
  { machineId: Schema.String, personId: Schema.String },
) {}

/** Org policy forbids the request outright (`never`), or the configured approval mode is too weak for the requested level. */
export class ElevationPolicyDeniedError extends Schema.TaggedError<ElevationPolicyDeniedError>()(
  "ElevationPolicyDeniedError",
  { reason: Schema.String },
) {}

/** The elevation exists but is not in a state the requested operation can act on (e.g. expiring a non-granted elevation). */
export class ElevationStateError extends Schema.TaggedError<ElevationStateError>()(
  "ElevationStateError",
  { elevationId: Schema.String, reason: Schema.String },
) {}

/** `ApprovalService.request`/`.status` failed. Unit 5 owns the real cause; we just surface it. */
export class ApprovalServiceCallError extends Schema.TaggedError<ApprovalServiceCallError>()(
  "ApprovalServiceCallError",
  { reason: Schema.String },
) {}

/** Any unexpected database failure. */
export class ElevationInfraError extends Schema.TaggedError<ElevationInfraError>()(
  "ElevationInfraError",
  { reason: Schema.String },
) {}

export type ElevationDomainError =
  | ElevationValidationError
  | MachineNotFoundError
  | PersonNotFoundError
  | ElevationNotFoundError
  | SelfOwnedMachineError
  | ElevationPolicyDeniedError
  | ElevationStateError
  | ApprovalServiceCallError
  | ElevationInfraError;
