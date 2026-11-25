// ---------------------------------------------------------------------------
// A person editing a package manifest, with the approval an ensure setting
// needs (CLAUDE.md invariant 4).
//
// Moving a package to *Ensure installed* or *Ensure latest version*, or
// between the two, makes Cloudable install software on every machine the entry
// reaches without anyone asking again. So that move waits for a
// `package_ensure` approval (mode set on the Organisation page, default
// `single`) and is written only once it is granted. Every other edit, moving
// back to *Allowed* included, applies at once: it cannot make Cloudable
// install anything.
//
// The writers (`MachineService.updatePackages`, `updateOrgPackages`, which also writes a
// profile's entries) do not
// ask for approval themselves. Everything a person edits goes through here;
// `domain/approvals/carry-out.ts` calls the writers directly once an approval
// is granted.
// ---------------------------------------------------------------------------
import {
  type PackageEnsureApprovalView,
  type PackageSetting,
  isEnsureSetting,
} from "@cloudable/contracts";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import type { Db } from "../../db/layer";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import type { EventBus } from "../../services/EventBus";
import {
  type OrgPackageEdit,
  type OrgPackageEntry,
  listOrgPackages,
  listProfilePackages,
  updateOrgPackages,
} from "../organisation/packages";
import { MachineService, type PackageManifestEdit } from "./MachineService";
import { PackageLockConflictError, ensureSettingError } from "./errors";
import { findEnsureSettingProblems } from "./manifest";

export const SETTING_LABELS: Record<PackageSetting, string> = {
  allowed: "Allowed",
  ensure_installed: "Ensure installed",
  ensure_latest: "Ensure latest version",
};

/** What a `package_ensure` approval stores, and what is written once it is granted. */
export interface PackageEnsurePayload {
  readonly scope: "org" | "profile" | "machine";
  readonly machineId: string | null;
  /** Set when `scope` is `profile`. */
  readonly profileId?: string;
  readonly edit: PackageManifestEdit;
}

const PackageEnsurePayloadSchema = Schema.Struct({
  scope: Schema.Literal("org", "profile", "machine"),
  machineId: Schema.NullOr(Schema.String),
  profileId: Schema.optional(Schema.String),
  edit: Schema.Struct({
    packageName: Schema.String,
    versionPin: Schema.optional(Schema.NullOr(Schema.String)),
    locked: Schema.optional(Schema.Boolean),
    // The lock flag's first name. Approvals asked for before the rename store it this way.
    pinned: Schema.optional(Schema.Boolean),
    excluded: Schema.optional(Schema.Boolean),
    partOf: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.NullOr(Schema.String)),
    setting: Schema.optional(Schema.Literal("allowed", "ensure_installed", "ensure_latest")),
  }),
});

export const decodePackageEnsurePayload = Schema.decodeUnknownOption(PackageEnsurePayloadSchema);

/** What the scope says about a package before the edit: its setting, and its own version pin. */
interface PreviousEntry {
  setting: PackageSetting;
  /** The pin an edit that omits `versionPin` keeps: the scope's own row's, never an inherited one. */
  ownVersionPin: string | null;
}

/**
 * The edits that need an approval: those that move a package to an ensure
 * setting it does not already have. "Already" is judged on what the scope
 * resolves to, so a machine row repeating the org's ensure setting asks for
 * nothing new.
 */
export const needsEnsureApproval = (
  edit: { setting?: PackageSetting | undefined },
  previous: PackageSetting,
): boolean =>
  edit.setting !== undefined && isEnsureSetting(edit.setting) && edit.setting !== previous;

const reasonFor = (edit: PackageManifestEdit): string =>
  `Set ${edit.packageName} to ${SETTING_LABELS[edit.setting ?? "allowed"]}`;

const toView = (packageName: string, approval: ApprovalResult): PackageEnsureApprovalView => ({
  packageName,
  approvalId: approval.id,
  status: approval.status,
});

/**
 * Validates the ensure edits as they will be written, before any approval is
 * asked for, so an approver is never asked about something that would then be
 * refused.
 */
const checkEnsureEdits = (
  edits: ReadonlyArray<PackageManifestEdit>,
  previousByName: ReadonlyMap<string, PreviousEntry>,
) => {
  const problems = findEnsureSettingProblems(
    edits.map((edit) => ({
      packageName: edit.packageName,
      setting: edit.setting ?? previousByName.get(edit.packageName)?.setting ?? "allowed",
      versionPin:
        edit.versionPin !== undefined
          ? edit.versionPin
          : (previousByName.get(edit.packageName)?.ownVersionPin ?? null),
    })),
  );
  return problems.length > 0 ? Effect.fail(ensureSettingError(problems)) : Effect.void;
};

const askForApproval = (input: {
  orgId: string;
  personId: string;
  scope: "org" | "profile" | "machine";
  machineId: string | null;
  profileId?: string;
  edit: PackageManifestEdit;
}) =>
  Effect.gen(function* () {
    const approvalService = yield* ApprovalService;
    const payload: PackageEnsurePayload = {
      scope: input.scope,
      machineId: input.machineId,
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      edit: input.edit,
    };
    return yield* approvalService
      .request({
        orgId: input.orgId,
        actionType: "package_ensure",
        requestedByPersonId: input.personId,
        targetMachineId: input.machineId,
        reason: reasonFor(input.edit),
        payload,
      })
      // The reason is always ours and never empty, so the only failures left are infrastructure.
      .pipe(Effect.orDie);
  });

/** `PATCH /machines/:id/packages`, with ensure edits held back for approval. */
export const requestMachineManifestEdit = (input: {
  machineId: string;
  orgId: string;
  personId: string;
  upserts?: ReadonlyArray<PackageManifestEdit> | undefined;
  removals?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const machineService = yield* MachineService;
    const detail = yield* machineService.getById(input.machineId, input.orgId);
    const previousByName = new Map<string, PreviousEntry>(
      detail.manifest.map((entry) => [
        entry.packageName,
        {
          setting: entry.setting,
          ownVersionPin: entry.source === "machine" ? entry.versionPin : null,
        },
      ]),
    );
    const upserts = input.upserts ?? [];
    const gated = upserts.filter((edit) =>
      needsEnsureApproval(edit, previousByName.get(edit.packageName)?.setting ?? "allowed"),
    );
    const direct = upserts.filter((edit) => !gated.includes(edit));

    yield* checkEnsureEdits(gated, previousByName);
    // A locked entry above the machine cannot be overridden here, ensure or not. Checked now
    // so nobody approves an edit the writer would refuse.
    const lockedAbove = gated.flatMap((edit) => {
      const entry = detail.manifest.find((row) => row.packageName === edit.packageName);
      return entry?.locked && entry.source !== "machine" ? [entry] : [];
    });
    if (lockedAbove.length > 0) {
      return yield* Effect.fail(
        new PackageLockConflictError({
          error: {
            code: "locked_entry_conflict",
            message: `${lockedAbove.length} package(s) are locked above the machine scope and cannot be overridden below.`,
            requestId: ulid(),
            details: {
              conflicts: lockedAbove.map((entry) => ({
                packageName: entry.packageName,
                lockedAtScope: entry.source,
                lockedAtScopeId: entry.resolvedFromScopeId,
                lockedVersionPin: entry.versionPin,
              })),
            },
          },
        }),
      );
    }

    let manifest = detail.manifest;
    if (direct.length > 0 || (input.removals ?? []).length > 0) {
      ({ manifest } = yield* machineService.updatePackages({
        machineId: input.machineId,
        orgId: input.orgId,
        upserts: direct,
        removals: input.removals,
        actorPersonId: input.personId,
      }));
    }

    const ensureApprovals: PackageEnsureApprovalView[] = [];
    for (const edit of gated) {
      const approval = yield* askForApproval({
        orgId: input.orgId,
        personId: input.personId,
        scope: "machine",
        machineId: input.machineId,
        edit,
      });
      if (approval.status === "approved") {
        ({ manifest } = yield* machineService.updatePackages({
          machineId: input.machineId,
          orgId: input.orgId,
          upserts: [edit],
          actorPersonId: input.personId,
        }));
      }
      ensureApprovals.push(toView(edit.packageName, approval));
    }

    return { manifest, ...(ensureApprovals.length > 0 ? { ensureApprovals } : {}) };
  });

/**
 * `PATCH /organisation/packages`, and `PATCH /profiles/:id/packages` when `profileId` is set,
 * with ensure edits held back for approval. A profile's Ensure setting needs the same approval
 * as the org's: it installs software on every machine on the profile.
 */
export const requestOrgManifestEdit = (input: {
  orgId: string;
  profileId?: string | undefined;
  personId: string;
  upserts?: ReadonlyArray<OrgPackageEdit> | undefined;
  removals?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const profileId = input.profileId;
    const current =
      profileId !== undefined
        ? yield* listProfilePackages(input.orgId, profileId)
        : yield* listOrgPackages(input.orgId);
    const previousByName = new Map<string, PreviousEntry>(
      current.map((entry) => [
        entry.packageName,
        { setting: entry.setting, ownVersionPin: entry.versionPin },
      ]),
    );
    const upserts = input.upserts ?? [];
    const gated = upserts.filter((edit) =>
      needsEnsureApproval(edit, previousByName.get(edit.packageName)?.setting ?? "allowed"),
    );
    const direct = upserts.filter((edit) => !gated.includes(edit));

    yield* checkEnsureEdits(gated, previousByName);

    const actor = { actorType: "person" as const, actorId: input.personId };
    let items: OrgPackageEntry[] = current;
    if (direct.length > 0 || (input.removals ?? []).length > 0) {
      items = yield* updateOrgPackages({
        orgId: input.orgId,
        profileId,
        upserts: direct,
        removals: input.removals,
        actor,
      });
    }

    const ensureApprovals: PackageEnsureApprovalView[] = [];
    for (const edit of gated) {
      const approval = yield* askForApproval({
        orgId: input.orgId,
        personId: input.personId,
        scope: profileId !== undefined ? "profile" : "org",
        machineId: null,
        ...(profileId !== undefined ? { profileId } : {}),
        edit,
      });
      if (approval.status === "approved") {
        items = yield* updateOrgPackages({ orgId: input.orgId, profileId, upserts: [edit], actor });
      }
      ensureApprovals.push(toView(edit.packageName, approval));
    }

    return { items, ...(ensureApprovals.length > 0 ? { ensureApprovals } : {}) };
  });

/**
 * Writes a granted `package_ensure` edit, attributed to the person who asked
 * for it. Called once per approval by `domain/approvals/carry-out.ts`.
 */
export const applyApprovedEnsureEdit = (
  approval: ApprovalResult,
): Effect.Effect<void, never, Db | EventBus | MachineService> =>
  Effect.gen(function* () {
    const decoded = decodePackageEnsurePayload(approval.payload);
    if (decoded._tag === "None") {
      return yield* Effect.logError(`approval ${approval.id}: package_ensure payload unreadable`);
    }
    const { scope, machineId, profileId } = decoded.value;
    if (scope === "profile" && profileId === undefined) {
      return yield* Effect.logError(`approval ${approval.id}: package_ensure for a profile names none`);
    }
    const { pinned, ...rest } = decoded.value.edit;
    const edit = rest.locked === undefined && pinned !== undefined ? { ...rest, locked: pinned } : rest;
    const write: Effect.Effect<void, unknown, Db | EventBus | MachineService> =
      scope !== "machine" || machineId === null
        ? updateOrgPackages({
            orgId: approval.orgId,
            profileId: scope === "profile" ? profileId : undefined,
            upserts: [edit],
            actor: { actorType: "person", actorId: approval.requestedByPersonId },
          }).pipe(Effect.asVoid)
        : Effect.flatMap(MachineService, (machineService) =>
            machineService.updatePackages({
              machineId,
              orgId: approval.orgId,
              upserts: [edit],
              actorPersonId: approval.requestedByPersonId,
            }),
          ).pipe(Effect.asVoid);
    // The approval stands either way; it is evidence of the decision. What usually fails here is
    // a manifest that changed while the request waited (a new lock above the machine, say), and
    // the person can ask again.
    yield* write.pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(
          `approval ${approval.id}: granted, but the ensure setting was not written: ${describeError(error)}`,
        ),
      ),
    );
  });

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const inner = (error as { error?: { message?: unknown } }).error;
    if (inner && typeof inner.message === "string") return inner.message;
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return String(error);
};
