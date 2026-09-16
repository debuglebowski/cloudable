import type { AccessMethodsEnabled } from "@cloudable/contracts";
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  InvalidCursorError,
  InvalidMachineRequestError,
  MachineNotFoundError,
  PackageActionRejected,
  PackagePinConflictError,
} from "../../domain/machine/errors";
import { CurrentUserAuthentication } from "../middleware/auth";

const machineProviderSchema = Schema.Literal("azure", "docker", "fake");

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
  excluded: Schema.Boolean,
  source: manifestScopeSchema,
  resolvedFromScopeId: Schema.String,
});

const resolvedPersistentPathsSchema = Schema.Struct({
  value: Schema.Array(Schema.String),
  source: manifestScopeSchema,
  resolvedFromScopeId: Schema.String,
});

/**
 * Every key of `AccessMethodsEnabled` must appear here. An Effect `Schema.Struct` STRIPS
 * fields it does not declare when encoding the response, so a key missing from this list
 * is computed correctly server-side and then silently deleted on the way out — which is
 * exactly what happened when `files` was added: the resolver merged it, the policy gate
 * honoured it, and the wire never carried it, so the CLI and console both reported a
 * machine as having only a web terminal and SSH.
 *
 * TypeScript cannot catch that on its own, because a Schema is a runtime value and not the
 * interface. The `satisfies` below is the link: it fails to compile if this struct and
 * `AccessMethodsEnabled` ever disagree about which keys exist.
 */
const accessMethodsEnabledValueSchema = Schema.Struct({
  webTerminal: Schema.Boolean,
  ssh: Schema.Boolean,
  files: Schema.Boolean,
});

const _accessMethodsKeysMatchContract = {} as Schema.Schema.Type<
  typeof accessMethodsEnabledValueSchema
> satisfies AccessMethodsEnabled;

const resolvedAccessMethodsEnabledSchema = Schema.Struct({
  value: accessMethodsEnabledValueSchema,
  source: manifestScopeSchema,
  resolvedFromScopeId: Schema.String,
});

const machineSummaryFields = {
  id: Schema.UUID,
  orgId: Schema.UUID,
  templateId: Schema.NullOr(Schema.UUID),
  ownerPersonId: Schema.NullOr(Schema.UUID),
  name: Schema.String,
  provider: machineProviderSchema,
  region: Schema.NullOr(Schema.String),
  sizeSku: Schema.String,
  image: Schema.String,
  state: machineStateSchema,
  lastError: Schema.NullOr(Schema.String),
  lastVerifiedAt: Schema.NullOr(Schema.DateFromString),
  createdAt: Schema.DateFromString,
};

const machineSummarySchema = Schema.Struct(machineSummaryFields);

// Logging tier resolves org → machine, same chain as everything
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
  // Optional — MachineService.create generates a friendly, org-unique
  // default when omitted or blank.
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  provider: machineProviderSchema,
  // Required iff provider === "azure" (and must name an org-enabled
  // region); forbidden otherwise — enforced in `MachineService.create`,
  // not at the wire-schema level, since it needs the org's catalog to check
  // against.
  region: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  sizeSku: Schema.String.pipe(Schema.minLength(1)),
  image: Schema.String.pipe(Schema.minLength(1)),
  // Required, never omitted — a machine always has exactly one owner,
  // always a person.
  ownerPersonId: Schema.UUID,
  templateId: Schema.optional(Schema.NullOr(Schema.UUID)),
});

const listMachinesUrlParamsSchema = Schema.Struct({
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
  // `true` writes "not on this machine", overriding the org's entry. An
  // omitted field keeps the machine row's current value, so this never
  // silently resets a pin (see `MachineService.updatePackages`).
  excluded: Schema.optional(Schema.Boolean),
});

const updateMachinePackagesPayloadSchema = Schema.Struct({
  upserts: Schema.optional(Schema.Array(packageManifestEntrySchema)),
  removals: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
});

const updateMachinePackagesResponseSchema = Schema.Struct({
  manifest: Schema.Array(resolvedManifestEntrySchema),
});

const manifestHistoryStateSchema = Schema.Struct({
  versionPin: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  excluded: Schema.Boolean,
});

/**
 * One recorded manifest change. `previous`/`current` are `null` when the
 * package had no entry on that side, so an add reads as `null -> value` and a
 * removal as `value -> null`.
 */
const manifestHistoryEntrySchema = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.String,
  recordedAt: Schema.String,
  actorType: Schema.Literal("person", "system", "agent", "idp"),
  actorId: Schema.String,
  correlationId: Schema.String,
  scope: Schema.Literal("org", "machine"),
  packageName: Schema.String,
  previous: Schema.NullOr(manifestHistoryStateSchema),
  current: Schema.NullOr(manifestHistoryStateSchema),
});

const packageRowSchema = Schema.Struct({
  packageName: Schema.String,
  // `null` is a real value here, not a missing one: the agent found the
  // package installed and no manifest entry covers it.
  permission: Schema.NullOr(Schema.Literal("allowed", "disallowed")),
  versionPin: Schema.NullOr(Schema.String),
  source: Schema.NullOr(manifestScopeSchema),
  // "unknown" is not "not_installed" — a machine that has never reported has
  // told us nothing.
  installed: Schema.Literal("installed", "not_installed", "unknown"),
  installedVersion: Schema.optional(Schema.String),
  versionMismatch: Schema.Boolean,
  isBaseline: Schema.Boolean,
  pendingAction: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      op: Schema.Literal("install", "uninstall"),
      status: Schema.Literal("pending", "running", "succeeded", "failed", "expired"),
      requestedAt: Schema.String,
      failureReason: Schema.optional(Schema.String),
    }),
  ),
});

const machinePackagesResponseSchema = Schema.Struct({
  items: Schema.Array(packageRowSchema),
  lastReportedAt: Schema.NullOr(Schema.String),
});

const packageActionPathSchema = Schema.Struct({
  id: Schema.UUID,
  packageName: Schema.String.pipe(Schema.minLength(1)),
});

const createPackageActionPayloadSchema = Schema.Struct({
  op: Schema.Literal("install", "uninstall"),
});

const createPackageActionResponseSchema = Schema.Struct({
  action: Schema.Struct({
    id: Schema.String,
    op: Schema.Literal("install", "uninstall"),
    status: Schema.Literal("pending", "running", "succeeded", "failed", "expired"),
    requestedAt: Schema.String,
    failureReason: Schema.optional(Schema.String),
  }),
});

const manifestHistoryUrlParamsSchema = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
});

const manifestHistoryResponseSchema = Schema.Struct({
  items: Schema.Array(manifestHistoryEntrySchema),
  nextCursor: Schema.NullOr(Schema.String),
});

/**
 * Machine desired-state API. All endpoints live under
 * `/api/v1/machines`; `.prefix()` is called last (after every `.add()`) since
 * `HttpApiGroup#prefix` only prefixes endpoints already added to the group.
 */
export const MachinesGroup = HttpApiGroup.make("machines")
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(createMachinePayloadSchema)
      .addSuccess(machineSummarySchema, { status: 201 })
      .addError(InvalidMachineRequestError, { status: 422 }),
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
  .add(
    // The packages table: what the manifest allows, joined with what the agent
    // reported is actually installed.
    HttpApiEndpoint.get("packages", "/:id/packages")
      .setPath(machineIdPathSchema)
      .addSuccess(machinePackagesResponseSchema)
      .addError(MachineNotFoundError, { status: 404 }),
  )
  .add(
    // Asks the machine to install or remove one package. Nothing happens at
    // the moment of the request beyond recording it — the agent collects it on
    // its next poll.
    HttpApiEndpoint.post("createPackageAction", "/:id/packages/:packageName/actions")
      .setPath(packageActionPathSchema)
      .setPayload(createPackageActionPayloadSchema)
      .addSuccess(createPackageActionResponseSchema, { status: 202 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(PackageActionRejected, { status: 422 }),
  )
  .add(
    // Read-only projection over the append-only event log: every package
    // manifest change that affects this machine, its own and the org's.
    HttpApiEndpoint.get("manifestHistory", "/:id/manifest-history")
      .setPath(machineIdPathSchema)
      .setUrlParams(manifestHistoryUrlParamsSchema)
      .addSuccess(manifestHistoryResponseSchema)
      .addError(MachineNotFoundError, { status: 404 }),
  )
  .prefix("/api/v1/machines")
  .middleware(CurrentUserAuthentication);
