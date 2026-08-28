import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  ApprovalServiceCallError,
  type Elevation,
  ElevationInfraError,
  ElevationNotFoundError,
  ElevationPolicyDeniedError,
  ElevationStateError,
  ElevationValidationError,
  MachineNotFoundError,
  PersonNotFoundError,
  SelfOwnedMachineError,
} from "../../domain/elevation/types";

// Kept separate from `http/handlers/elevations.ts` (which implements the
// handlers) rather than combined into one file: `http/api.ts` imports
// `ElevationsGroup` from here to build `Api`, and the handlers need `Api`
// itself (to call `HttpApiBuilder.group(Api, "elevations", ...)`) — putting
// both in one file would make `api.ts` and this file import each other.

export const ElevationLevelSchema = Schema.Literal("file_recovery", "shell");
export const ElevationStatusSchema = Schema.Literal("requested", "granted", "expired", "denied");

export const ElevationIdPath = Schema.Struct({ id: Schema.String });

export const RequestElevationPayload = Schema.Struct({
  personId: Schema.String,
  machineId: Schema.String,
  level: ElevationLevelSchema,
  reason: Schema.String,
});

export const ElevationSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  personId: Schema.String,
  machineId: Schema.String,
  level: ElevationLevelSchema,
  reason: Schema.String,
  approvalId: Schema.NullOr(Schema.String),
  grantedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  status: ElevationStatusSchema,
});

export function toWire(elevation: Elevation): typeof ElevationSchema.Type {
  return {
    id: elevation.id,
    orgId: elevation.orgId,
    personId: elevation.personId,
    machineId: elevation.machineId,
    level: elevation.level,
    reason: elevation.reason,
    approvalId: elevation.approvalId,
    grantedAt: elevation.grantedAt ? elevation.grantedAt.toISOString() : null,
    expiresAt: elevation.expiresAt ? elevation.expiresAt.toISOString() : null,
    status: elevation.status,
  };
}

/**
 * `/api/v1/elevations` — request, view, manually sync a pending approval,
 * and manually expire an elevation (spec §15). No auth middleware is wired
 * up anywhere in the app yet (see `http/middleware/auth.ts`), so `personId`
 * is taken from the request body rather than a session — same as every
 * other unauthenticated endpoint in this skeleton.
 */
export const ElevationsGroup = HttpApiGroup.make("elevations")
  .add(
    HttpApiEndpoint.post("request", "/api/v1/elevations")
      .setPayload(RequestElevationPayload)
      .addSuccess(ElevationSchema, { status: 201 })
      .addError(ElevationValidationError, { status: 400 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(PersonNotFoundError, { status: 404 })
      .addError(SelfOwnedMachineError, { status: 422 })
      .addError(ElevationPolicyDeniedError, { status: 403 })
      .addError(ApprovalServiceCallError, { status: 502 })
      .addError(ElevationInfraError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("get", "/api/v1/elevations/:id")
      .setPath(ElevationIdPath)
      .addSuccess(ElevationSchema)
      .addError(ElevationNotFoundError, { status: 404 })
      .addError(ElevationInfraError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("sync", "/api/v1/elevations/:id/sync")
      .setPath(ElevationIdPath)
      .addSuccess(ElevationSchema)
      .addError(ElevationNotFoundError, { status: 404 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(ApprovalServiceCallError, { status: 502 })
      .addError(ElevationInfraError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("expire", "/api/v1/elevations/:id/expire")
      .setPath(ElevationIdPath)
      .addSuccess(ElevationSchema)
      .addError(ElevationNotFoundError, { status: 404 })
      .addError(ElevationStateError, { status: 409 })
      .addError(ElevationInfraError, { status: 500 }),
  );
