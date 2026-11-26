import { type AccessMethodsEnabled, isValidDeclaredPackageName } from "@cloudable/contracts";
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  InvalidCursorError,
  InvalidMachineRequestError,
  MachineNotFoundError,
  MachinePowerConflictError,
  PackageActionRejected,
  PackageEnsureSettingError,
  PackageLockConflictError,
} from "../../domain/machine/errors";
import { ResizeRefusedError } from "../../domain/machine/resize";
import { CurrentUserAuthentication } from "../middleware/auth";
import { ApprovalResource } from "./approvals";

const machineProviderSchema = Schema.Literal("azure", "docker", "fake");

const machineStateSchema = Schema.Literal(
  "provisioning",
  "running",
  "stopped",
  "archived_restorable",
  "archived_expired",
  "error",
);

const manifestScopeSchema = Schema.Literal("org", "profile", "machine");

// What Cloudable does about a declared package. See `PackageSetting` in the contracts package.
export const packageSettingSchema = Schema.Literal("allowed", "ensure_installed", "ensure_latest");

export const ensureApprovalSchema = Schema.Struct({
  packageName: Schema.String,
  approvalId: Schema.String,
  status: Schema.Literal("pending", "approved", "rejected", "expired"),
});

const resolvedManifestEntrySchema = Schema.Struct({
  packageName: Schema.String,
  versionPin: Schema.NullOr(Schema.String),
  locked: Schema.Boolean,
  excluded: Schema.Boolean,
  partOf: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  setting: packageSettingSchema,
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
  snapshotInspect: Schema.Boolean,
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
  profileId: Schema.NullOr(Schema.UUID),
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
// "machine" when it does (never "profile" in v1 — the layer is inert).
const effectiveLoggingTierSchema = Schema.Struct({
  tier: Schema.Literal(1, 2),
  source: manifestScopeSchema,
});

const machineDetailSchema = Schema.Struct({
  agentUpdate: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        installedVersion: Schema.String,
        desiredVersion: Schema.NullOr(Schema.String),
        releaseId: Schema.NullOr(Schema.String),
        status: Schema.String,
      }),
    ),
  ),
  desiredAgentRelease: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        version: Schema.String,
        releaseId: Schema.String,
      }),
    ),
  ),
  // A stop or start under way, else null. `state` changes once it is done.
  powerTransition: Schema.optional(Schema.NullOr(Schema.Literal("stopping", "starting"))),
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
  // Provider, size and image may be left out when the profile sets them.
  provider: Schema.optional(machineProviderSchema),
  // Required iff provider === "azure" (and must name an org-enabled
  // region); forbidden otherwise — enforced in `MachineService.create`,
  // not at the wire-schema level, since it needs the org's catalog to check
  // against.
  region: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  sizeSku: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  image: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  // Required, never omitted — a machine always has exactly one owner,
  // always a person.
  ownerPersonId: Schema.UUID,
  profileId: Schema.optional(Schema.NullOr(Schema.UUID)),
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

const computePointSchema = Schema.Struct({
  at: Schema.String,
  cpuAverage: Schema.NullOr(Schema.Number),
  cpuMax: Schema.NullOr(Schema.Number),
  creditsMin: Schema.NullOr(Schema.Number),
});

const machineComputeSchema = Schema.Struct({
  sizeSku: Schema.String,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(Schema.String),
  burstable: Schema.Boolean,
  hours: Schema.Number,
  points: Schema.Array(computePointSchema),
  summary: Schema.Struct({
    cpuAverage: Schema.NullOr(Schema.Number),
    cpuPeak: Schema.NullOr(Schema.Number),
    creditsNow: Schema.NullOr(Schema.Number),
    hoursWithoutCredits: Schema.NullOr(Schema.Number),
  }),
});

const resizeMachinePayloadSchema = Schema.Struct({
  sizeSku: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  reason: Schema.String.pipe(Schema.maxLength(2000)),
});

const machinePowerResponseSchema = Schema.Struct({
  machineId: Schema.String,
  state: Schema.Literal("stopping", "starting"),
});

const resizeMachineResponseSchema = Schema.Struct({
  approvalId: Schema.String,
  status: Schema.Literal("pending", "approved", "rejected", "expired"),
});

// Moves a machine to another profile, or off one (null).
const setMachineProfilePayloadSchema = Schema.Struct({ profileId: Schema.NullOr(Schema.UUID) });

// An apt name, or `<manager>:<name>` (`npm:playwright`, `home:playwright-chromium`).
// See `PACKAGE_MANAGERS` in the contracts package.
const declaredPackageNameSchema = Schema.String.pipe(
  Schema.filter(isValidDeclaredPackageName, {
    message: () => "not a valid package name: use an apt name or <npm|pipx|cargo|nix|home>:<name>",
  }),
);

const packageManifestEntrySchema = Schema.Struct({
  packageName: declaredPackageNameSchema,
  versionPin: Schema.optional(Schema.NullOr(Schema.String)),
  locked: Schema.optional(Schema.Boolean),
  // `true` writes "not on this machine", overriding the org's entry. An
  // omitted field keeps the machine row's current value, so this never
  // silently resets a pin (see `MachineService.updatePackages`).
  excluded: Schema.optional(Schema.Boolean),
  // The declared parent this package is part of. Null clears it.
  partOf: Schema.optional(Schema.NullOr(declaredPackageNameSchema)),
  // Why it is allowed. Free text for people; nothing acts on it.
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(500)))),
  // Moving to an ensure setting waits for a `package_ensure` approval.
  setting: Schema.optional(packageSettingSchema),
}).pipe(
  Schema.filter((entry) => entry.partOf !== entry.packageName, {
    message: () => "a package cannot be part of itself",
  }),
);

const updateMachinePackagesPayloadSchema = Schema.Struct({
  upserts: Schema.optional(Schema.Array(packageManifestEntrySchema)),
  removals: Schema.optional(Schema.Array(Schema.String.pipe(Schema.minLength(1)))),
});

const updateMachinePackagesResponseSchema = Schema.Struct({
  manifest: Schema.Array(resolvedManifestEntrySchema),
  // One per edit that set an ensure setting; those wait for their approval.
  ensureApprovals: Schema.optional(Schema.Array(ensureApprovalSchema)),
});

const manifestHistoryStateSchema = Schema.Struct({
  versionPin: Schema.NullOr(Schema.String),
  locked: Schema.Boolean,
  excluded: Schema.Boolean,
  partOf: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  // Absent on changes recorded before settings existed: those were all `allowed`.
  setting: Schema.optional(packageSettingSchema),
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
  scope: Schema.Literal("org", "profile", "machine"),
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
  sourceProfileId: Schema.optional(Schema.String),
  // "unknown" is not "not_installed" — a machine that has never reported has
  // told us nothing.
  installed: Schema.Literal("installed", "not_installed", "unknown"),
  installedVersion: Schema.optional(Schema.String),
  versionMismatch: Schema.Boolean,
  isBaseline: Schema.Boolean,
  partOf: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  installedAsDependency: Schema.optional(Schema.Boolean),
  pendingAction: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      op: Schema.Literal("install", "uninstall"),
      trigger: Schema.optional(Schema.Literal("person", "ensure_installed", "ensure_latest")),
      status: Schema.Literal("pending", "running", "succeeded", "failed", "expired"),
      requestedAt: Schema.String,
      failureReason: Schema.optional(Schema.String),
    }),
  ),
  setting: Schema.optional(packageSettingSchema),
  availableVersion: Schema.optional(Schema.String),
  ensureFailure: Schema.optional(
    Schema.Struct({
      failedAt: Schema.String,
      reason: Schema.String,
      nextAttemptAt: Schema.String,
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
  // Shown to the approver of an install. Defaults to "Install <package>".
  reason: Schema.optional(Schema.String),
});

// An install that waits for an approver comes back with `action: null` and the pending
// `approval`; the action is queued when it is granted. A removal, or an install the org lets
// through without sign-off, comes back with the queued `action`.
const createPackageActionResponseSchema = Schema.Struct({
  action: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      op: Schema.Literal("install", "uninstall"),
      status: Schema.Literal("pending", "running", "succeeded", "failed", "expired"),
      requestedAt: Schema.String,
      failureReason: Schema.optional(Schema.String),
    }),
  ),
  approval: Schema.NullOr(ApprovalResource),
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
    // How hard the machine works, from the cloud provider's own measurements: hourly CPU and,
    // on a burstable size, CPU credits. The owner or an admin.
    HttpApiEndpoint.get("compute", "/:id/compute")
      .setPath(machineIdPathSchema)
      .setUrlParams(Schema.Struct({ hours: Schema.optional(Schema.NumberFromString) }))
      .addSuccess(machineComputeSchema)
      .addError(MachineNotFoundError, { status: 404 }),
  )
  .add(
    // Ask for a new size. Waits for a `machine_resize` approval; carried out in the background.
    HttpApiEndpoint.post("resize", "/:id/resize")
      .setPath(machineIdPathSchema)
      .setPayload(resizeMachinePayloadSchema)
      .addSuccess(resizeMachineResponseSchema, { status: 202 })
      .addError(ResizeRefusedError, { status: 422 }),
  )
  .add(
    // Stop the machine to save money: deallocated, no compute cost, disks stay. The owner or
    // an admin, no approval. Carried out in the background.
    HttpApiEndpoint.post("stop", "/:id/stop")
      .setPath(machineIdPathSchema)
      .addSuccess(machinePowerResponseSchema, { status: 202 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(MachinePowerConflictError, { status: 409 }),
  )
  .add(
    // Start a stopped machine, exactly as it was. Same people, same background run.
    HttpApiEndpoint.post("start", "/:id/start")
      .setPath(machineIdPathSchema)
      .addSuccess(machinePowerResponseSchema, { status: 202 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(MachinePowerConflictError, { status: 409 }),
  )
  .add(
    // An admin moves a machine to another profile, or off one. Recorded as
    // `machine.profile_assigned`.
    HttpApiEndpoint.put("setProfile", "/:id/profile")
      .setPath(machineIdPathSchema)
      .setPayload(setMachineProfilePayloadSchema)
      .addSuccess(machineSummarySchema)
      .addError(MachineNotFoundError, { status: 404 })
      .addError(InvalidMachineRequestError, { status: 422 }),
  )
  .add(
    HttpApiEndpoint.patch("updatePackages", "/:id/packages")
      .setPath(machineIdPathSchema)
      .setPayload(updateMachinePackagesPayloadSchema)
      .addSuccess(updateMachinePackagesResponseSchema)
      .addError(MachineNotFoundError, { status: 404 })
      .addError(PackageLockConflictError, { status: 422 })
      .addError(PackageEnsureSettingError, { status: 422 }),
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
