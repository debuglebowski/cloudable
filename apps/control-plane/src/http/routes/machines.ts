import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  InvalidCursorError,
  MachineNotFoundError,
  PackagePinConflictError,
} from "../../domain/machine/errors";

const machineStateSchema = Schema.Literal(
  "provisioning",
  "running",
  "stopped",
  "archived_restorable",
  "archived_expired",
  "error",
);

const manifestScopeSchema = Schema.Literal("org", "template", "machine");

const resolvedManifestEntrySchema = Schema.Struct({
  packageName: Schema.String,
  versionPin: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  source: manifestScopeSchema,
  resolvedFromScopeId: Schema.String,
});

const resolvedPersistentPathsSchema = Schema.Struct({
  value: Schema.Array(Schema.String),
  source: manifestScopeSchema,
  resolvedFromScopeId: Schema.String,
});

const resolvedAccessMethodsEnabledSchema = Schema.Struct({
  value: Schema.Struct({ webTerminal: Schema.Boolean, ssh: Schema.Boolean }),
  source: manifestScopeSchema,
  resolvedFromScopeId: Schema.String,
});

const machineSummaryFields = {
  id: Schema.UUID,
  orgId: Schema.UUID,
  templateId: Schema.NullOr(Schema.UUID),
  ownerPersonId: Schema.NullOr(Schema.UUID),
  name: Schema.String,
  region: Schema.String,
  sizeSku: Schema.String,
  image: Schema.String,
  state: machineStateSchema,
  lastVerifiedAt: Schema.NullOr(Schema.DateFromString),
  createdAt: Schema.DateFromString,
};

const machineSummarySchema = Schema.Struct(machineSummaryFields);

// spec §17: logging tier resolves org → machine, same chain as everything
// else — `source` is "org" when the machine has no override of its own,
// "machine" when it does (never "template" in v1 — the layer is inert).
const effectiveLoggingTierSchema = Schema.Struct({
  tier: Schema.Literal(1, 2, 3),
  source: manifestScopeSchema,
});

const machineDetailSchema = Schema.Struct({
  ...machineSummaryFields,
  manifest: Schema.Array(resolvedManifestEntrySchema),
  persistentPaths: resolvedPersistentPathsSchema,
  accessMethodsEnabled: resolvedAccessMethodsEnabledSchema,
  loggingTier: effectiveLoggingTierSchema,
});

const pageInfoSchema = Schema.Struct({
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
});

const createMachinePayloadSchema = Schema.Struct({
  orgId: Schema.UUID,
  name: Schema.String.pipe(Schema.minLength(1)),
  // Optional — omitted, `MachineService.create` resolves the org's
  // configured default region instead of requiring the caller to always
  // supply one (docs/inheritance.md, spec.md §5).
  region: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  sizeSku: Schema.String.pipe(Schema.minLength(1)),
  image: Schema.String.pipe(Schema.minLength(1)),
  // Required, never omitted: CLAUDE.md invariant #3 — a machine always has
  // exactly one owner, always a person. See docs/inheritance.md.
  ownerPersonId: Schema.UUID,
  templateId: Schema.optional(Schema.NullOr(Schema.UUID)),
  actorPersonId: Schema.optional(Schema.UUID),
});

const listMachinesUrlParamsSchema = Schema.Struct({
  orgId: Schema.UUID,
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

const listMachinesResponseSchema = Schema.Struct({
  items: Schema.Array(machineSummarySchema),
  pageInfo: pageInfoSchema,
});

const machineIdPathSchema = Schema.Struct({ id: Schema.UUID });

const packageManifestEntrySchema = Schema.Struct({
  packageName: Schema.String.pipe(Schema.minLength(1)),
  versionPin: Schema.optional(Schema.NullOr(Schema.String)),
  pinned: Schema.optional(Schema.Boolean),
});

const updateMachinePackagesPayloadSchema = Schema.Struct({
  upserts: Schema.optional(Schema.Array(packageManifestEntrySchema)),
  removals: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
  actorPersonId: Schema.optional(Schema.UUID),
});

const updateMachinePackagesResponseSchema = Schema.Struct({
  manifest: Schema.Array(resolvedManifestEntrySchema),
});

/**
 * Machine desired-state API — spec.md §5-7. All endpoints live under
 * `/api/v1/machines`; `.prefix()` is called last (after every `.add()`) since
 * `HttpApiGroup#prefix` only prefixes endpoints already added to the group.
 */
export const MachinesGroup = HttpApiGroup.make("machines")
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(createMachinePayloadSchema)
      .addSuccess(machineSummarySchema, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(listMachinesUrlParamsSchema)
      .addSuccess(listMachinesResponseSchema)
      .addError(InvalidCursorError, { status: 400 }),
  )
  .add(
    HttpApiEndpoint.get("byId", "/:id")
      .setPath(machineIdPathSchema)
      .addSuccess(machineDetailSchema)
      .addError(MachineNotFoundError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.patch("updatePackages", "/:id/packages")
      .setPath(machineIdPathSchema)
      .setPayload(updateMachinePackagesPayloadSchema)
      .addSuccess(updateMachinePackagesResponseSchema)
      .addError(MachineNotFoundError, { status: 404 })
      .addError(PackagePinConflictError, { status: 422 }),
  )
  .prefix("/api/v1/machines");
