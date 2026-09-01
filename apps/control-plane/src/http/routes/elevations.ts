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
import { CurrentUserAuthentication } from "../middleware/auth";

// Kept separate from `http/handlers/elevations.ts` (which implements the
// handlers) rather than combined into one file: `http/api.ts` imports
// `ElevationsGroup` from here to build `Api`, and the handlers need `Api`
// itself (to call `HttpApiBuilder.group(Api, "elevations", ...)`) — putting
// both in one file would make `api.ts` and this file import each other.

export const ElevationLevelSchema = Schema.Literal("file_recovery", "shell");
export const ElevationStatusSchema = Schema.Literal("requested", "granted", "expired", "denied");

export const ElevationIdPath = Schema.Struct({ id: Schema.String });

// `personId` is gone from the wire — derived from `CurrentUserTag.personId`
// in the handler. This is the person REQUESTING elevated access (the admin
// wanting to connect to a machine they don't own), not a client-supplied
// identity — otherwise a caller could request elevation attributed to
// someone else.
export const RequestElevationPayload = Schema.Struct({
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

export const ElevationListItemSchema = Schema.Struct({
  id: Schema.String,
  personId: Schema.String,
  machineId: Schema.String,
  machineName: Schema.String,
  level: ElevationLevelSchema,
  reason: Schema.String,
  status: ElevationStatusSchema,
  expiresAt: Schema.NullOr(Schema.String),
});
export const ListElevationsResponse = Schema.Struct({
  elevations: Schema.Array(ElevationListItemSchema),
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
 * and manually expire an elevation (spec §15). Org- and person-scoped via
 * the real session (`CurrentUserTag`, see `http/middleware/auth.ts` and
 * `http/api.ts`'s `.middleware(...)` on this group).
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
  )
  .add(
    HttpApiEndpoint.get("list", "/api/v1/elevations")
      .addSuccess(ListElevationsResponse)
      .addError(ElevationInfraError, { status: 500 }),
  )
  .middleware(CurrentUserAuthentication);
