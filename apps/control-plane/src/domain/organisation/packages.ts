import type { PackageSetting } from "@cloudable/contracts";
import type { OrgEvent } from "@cloudable/events";
import { machinePackages, orgs } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type Context, Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import {
  type PackageEnsureSettingError,
  PackageLockConflictError,
  ensureSettingError,
} from "../machine/errors";
import {
  type MachinePackageRow,
  findEnsureSettingProblems,
  findLockConflicts,
  packageSettingKey,
} from "../machine/manifest";

/**
 * Org-scope write path for the package manifest. `domain/machine/MachineService
 * .updatePackages` is the only other writer of `machine_packages`, and is
 * always `machine`-scoped — see its own file's header comment. This module
 * is the org-scope sibling: it writes `machine_packages` rows with
 * `scopeType: "org"` instead, which become the resolved default on any
 * machine that has neither its own machine-level entry nor an override for
 * that package name (docs/inheritance.md's "lowest level wins").
 *
 * Kept as a standalone module next to `domain/organisation/settings.ts`
 * (plain functions reading `Db`/`EventBus` from the Effect environment,
 * same convention) rather than a method on `MachineService`: an org-scope
 * edit isn't about any one machine, so there's no single machine id to
 * thread through `MachineService`'s machine-fetching helpers.
 */

export class OrgPackagesError extends Schema.TaggedError<OrgPackagesError>()("OrgPackagesError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface OrgPackageEntry {
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  /** The declared parent this package is part of, or null. */
  partOf: string | null;
  /** Why it is allowed, or null. */
  description: string | null;
  /** What Cloudable does about it. */
  setting: PackageSetting;
}

export interface OrgPackageEdit {
  packageName: string;
  versionPin?: string | null | undefined;
  locked?: boolean | undefined;
  /** Null clears it; omitted keeps the current value. */
  partOf?: string | null | undefined;
  /** Null clears it; omitted keeps the current value. */
  description?: string | null | undefined;
  /**
   * Omitted keeps it. Written as given: the approval for an ensure setting is
   * asked for by `domain/machine/package-ensure.ts` before this runs.
   */
  setting?: PackageSetting | undefined;
}

export interface OrgPackagesActor {
  actorType: "person" | "system";
  actorId: string;
}

export interface UpdateOrgPackagesInput {
  orgId: string;
  upserts?: ReadonlyArray<OrgPackageEdit> | undefined;
  removals?: ReadonlyArray<string> | undefined;
  actor: OrgPackagesActor;
}

/**
 * Namespaced so `org.setting_changed`'s generic `key` field can never
 * collide with one of the org's other settings (logging tier, retention,
 * approval mode) — same convention as `ApprovalService.settingKeyFor`'s
 * `approval_mode:<actionType>`.
 *
 * The definition moved to `domain/machine/manifest.ts` once the machine-scope
 * write path adopted the same convention; both paths must agree on it, since
 * `logging/tier-filter.ts` and the manifest-history query both recognise a
 * package edit by this prefix alone. Re-exported here for this module's
 * existing callers.
 */
export const orgPackageSettingKey = packageSettingKey;

const toEntry = (
  row: Pick<
    MachinePackageRow,
    "packageName" | "versionPin" | "locked" | "partOf" | "description" | "setting"
  >,
): OrgPackageEntry => ({
  packageName: row.packageName,
  versionPin: row.versionPin,
  locked: row.locked,
  partOf: row.partOf ?? null,
  description: row.description ?? null,
  setting: row.setting ?? "allowed",
});

const byPackageName = (a: OrgPackageEntry, b: OrgPackageEntry) =>
  a.packageName.localeCompare(b.packageName);

type DbHandle = Context.Tag.Service<typeof Db>;

const requireOrg = (db: DbHandle, orgId: string): Effect.Effect<void, OrgPackagesError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () => db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1),
      catch: (cause) => new OrgPackagesError({ reason: "read_failed", cause }),
    });
    if (!rows[0]) {
      return yield* Effect.fail(new OrgPackagesError({ reason: "org_not_found" }));
    }
  });

const fetchOrgRows = (
  db: DbHandle,
  orgId: string,
): Effect.Effect<MachinePackageRow[], OrgPackagesError> =>
  Effect.tryPromise({
    try: () =>
      db
        .select()
        .from(machinePackages)
        .where(and(eq(machinePackages.scopeType, "org"), eq(machinePackages.scopeId, orgId))),
    catch: (cause) => new OrgPackagesError({ reason: "read_failed", cause }),
  });

export const listOrgPackages = (
  orgId: string,
): Effect.Effect<OrgPackageEntry[], OrgPackagesError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* requireOrg(db, orgId);
    const rows = yield* fetchOrgRows(db, orgId);
    return rows.map(toEntry).sort(byPackageName);
  });

// `EventBus.publish` assigns the real ULID/`recordedAt`, overwriting these —
// see its doc comment and `domain/machine/events.ts`'s identical convention.
const PLACEHOLDER_ID = "";
const PLACEHOLDER_RECORDED_AT = new Date(0);

/**
 * An entry as the `org.setting_changed` payload stores it. The lock flag is
 * stored as `pinned`, its first name, so every recorded change has one shape.
 * Readers (`manifest-history.ts`, `evidence/projection.ts`) read `pinned`.
 */
type OrgPackageEventEntry = Omit<OrgPackageEntry, "locked"> & { pinned: boolean };

const toEventEntry = (entry: OrgPackageEntry | undefined): OrgPackageEventEntry | null => {
  if (!entry) return null;
  const { locked, ...rest } = entry;
  return { ...rest, pinned: locked };
};

function orgPackageSettingChangedEvent(input: {
  orgId: string;
  correlationId: string;
  actorType: "person" | "system";
  actorId: string;
  packageName: string;
  previous: OrgPackageEventEntry | null;
  current: OrgPackageEventEntry | null;
}): OrgEvent {
  return {
    id: PLACEHOLDER_ID,
    type: "org.setting_changed",
    occurredAt: new Date(),
    recordedAt: PLACEHOLDER_RECORDED_AT,
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    machineId: null,
    correlationId: input.correlationId,
    schemaVersion: 1,
    payload: {
      key: orgPackageSettingKey(input.packageName),
      previous: input.previous,
      current: input.current,
      level: "org",
    },
  };
}

/**
 * Upserts/removes org-scoped `machine_packages` rows. Runs through the exact
 * same `findLockConflicts` the machine-scope editor does — a lock
 * conflict is a 422 at edit time, never a silent no-op at reconcile. The lock
 * check is already scope-generic and needs no changes for org editing.
 * Nothing sits above `org` in
 * the chain, so `findLockConflicts(existingRows, "org", ...)` can never
 * actually report a conflict today; it's wired anyway so this path shares
 * one validation function with the machine-scope path rather than a second
 * copy that could silently drift from it.
 *
 * An upsert that omits `versionPin`/`locked` preserves that field's existing
 * value rather than resetting it to "any"/unlocked — critical for `locked`
 * specifically: a caller that PATCHes only `{ packageName, versionPin }`
 * against an already-locked entry must never silently strip its lock.
 */
export const updateOrgPackages = (
  input: UpdateOrgPackagesInput,
): Effect.Effect<
  OrgPackageEntry[],
  OrgPackagesError | PackageLockConflictError | PackageEnsureSettingError,
  Db | EventBus
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    yield* requireOrg(db, input.orgId);
    const upserts = input.upserts ?? [];
    const removals = input.removals ?? [];
    const editedPackageNames = [...new Set([...upserts.map((u) => u.packageName), ...removals])];

    const existingRows = yield* fetchOrgRows(db, input.orgId);

    const conflicts = findLockConflicts(existingRows, "org", editedPackageNames);
    if (conflicts.length > 0) {
      return yield* Effect.fail(
        new PackageLockConflictError({
          error: {
            code: "locked_entry_conflict",
            message: `${conflicts.length} package(s) are locked above the org scope and cannot be overridden below.`,
            requestId: ulid(),
            details: { conflicts },
          },
        }),
      );
    }

    const previousByName = new Map(existingRows.map((row) => [row.packageName, toEntry(row)]));

    // Resolve each upsert's effective values up front (falling back to the
    // existing row when a field is omitted) so the DB write, the returned
    // manifest, and the emitted event's `current` all agree on exactly the
    // same values — and so a second read after the write isn't needed to
    // learn what the write just did.
    const resolvedUpserts = upserts.map((upsert) => {
      const previous = previousByName.get(upsert.packageName);
      return {
        packageName: upsert.packageName,
        versionPin:
          upsert.versionPin !== undefined ? upsert.versionPin : (previous?.versionPin ?? null),
        locked: upsert.locked !== undefined ? upsert.locked : (previous?.locked ?? false),
        partOf: upsert.partOf !== undefined ? upsert.partOf : (previous?.partOf ?? null),
        description:
          upsert.description !== undefined ? upsert.description : (previous?.description ?? null),
        setting: upsert.setting !== undefined ? upsert.setting : (previous?.setting ?? "allowed"),
      };
    });

    const ensureProblems = findEnsureSettingProblems(resolvedUpserts);
    if (ensureProblems.length > 0) {
      return yield* Effect.fail(ensureSettingError(ensureProblems));
    }

    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          for (const upsert of resolvedUpserts) {
            await tx
              .insert(machinePackages)
              .values({
                scopeType: "org",
                scopeId: input.orgId,
                packageName: upsert.packageName,
                versionPin: upsert.versionPin,
                locked: upsert.locked,
                partOf: upsert.partOf,
                description: upsert.description,
                setting: upsert.setting,
                source: "org",
              })
              .onConflictDoUpdate({
                target: [
                  machinePackages.scopeType,
                  machinePackages.scopeId,
                  machinePackages.packageName,
                ],
                set: {
                  versionPin: upsert.versionPin,
                  locked: upsert.locked,
                  partOf: upsert.partOf,
                  description: upsert.description,
                  setting: upsert.setting,
                  source: "org",
                  updatedAt: new Date(),
                },
              });
          }
          for (const packageName of removals) {
            await tx
              .delete(machinePackages)
              .where(
                and(
                  eq(machinePackages.scopeType, "org"),
                  eq(machinePackages.scopeId, input.orgId),
                  eq(machinePackages.packageName, packageName),
                ),
              );
          }
        }),
      catch: (cause) => new OrgPackagesError({ reason: "write_failed", cause }),
    });

    const currentByName = new Map(previousByName);
    for (const upsert of resolvedUpserts) {
      currentByName.set(upsert.packageName, {
        packageName: upsert.packageName,
        versionPin: upsert.versionPin,
        locked: upsert.locked,
        partOf: upsert.partOf,
        description: upsert.description,
        setting: upsert.setting,
      });
    }
    for (const packageName of removals) {
      currentByName.delete(packageName);
    }

    if (editedPackageNames.length > 0) {
      const correlationId = ulid();
      const settingEvents = editedPackageNames.map((packageName) =>
        orgPackageSettingChangedEvent({
          orgId: input.orgId,
          correlationId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          packageName,
          previous: toEventEntry(previousByName.get(packageName)),
          current: toEventEntry(currentByName.get(packageName)),
        }),
      );
      yield* eventBus
        .publish(settingEvents)
        .pipe(
          Effect.mapError(
            (cause) => new OrgPackagesError({ reason: "event_publish_failed", cause }),
          ),
        );
    }

    return [...currentByName.values()].sort(byPackageName);
  });
