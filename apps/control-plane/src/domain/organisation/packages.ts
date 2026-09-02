import type { OrgEvent } from "@cloudable/events";
import { machinePackages, orgs } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type Context, Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { PackagePinConflictError } from "../machine/errors";
import { type MachinePackageRow, findPinConflicts } from "../machine/manifest";

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
  pinned: boolean;
}

export interface OrgPackageEdit {
  packageName: string;
  versionPin?: string | null | undefined;
  pinned?: boolean | undefined;
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
 */
export const orgPackageSettingKey = (packageName: string): string => `package:${packageName}`;

const toEntry = (
  row: Pick<MachinePackageRow, "packageName" | "versionPin" | "pinned">,
): OrgPackageEntry => ({
  packageName: row.packageName,
  versionPin: row.versionPin,
  pinned: row.pinned,
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

function orgPackageSettingChangedEvent(input: {
  orgId: string;
  correlationId: string;
  actorType: "person" | "system";
  actorId: string;
  packageName: string;
  previous: OrgPackageEntry | null;
  current: OrgPackageEntry | null;
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
 * same `findPinConflicts` the machine-scope editor does — a pin
 * conflict is a 422 at edit time, never a silent no-op at reconcile. The pin
 * check is already scope-generic and needs no changes for org editing.
 * Nothing sits above `org` in
 * the chain, so `findPinConflicts(existingRows, "org", ...)` can never
 * actually report a conflict today; it's wired anyway so this path shares
 * one validation function with the machine-scope path rather than a second
 * copy that could silently drift from it.
 *
 * An upsert that omits `versionPin`/`pinned` preserves that field's existing
 * value rather than resetting it to "any"/unpinned — critical for `pinned`
 * specifically: a caller that PATCHes only `{ packageName, versionPin }`
 * against an already-pinned entry must never silently strip its pin.
 */
export const updateOrgPackages = (
  input: UpdateOrgPackagesInput,
): Effect.Effect<OrgPackageEntry[], OrgPackagesError | PackagePinConflictError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    yield* requireOrg(db, input.orgId);
    const upserts = input.upserts ?? [];
    const removals = input.removals ?? [];
    const editedPackageNames = [...new Set([...upserts.map((u) => u.packageName), ...removals])];

    const existingRows = yield* fetchOrgRows(db, input.orgId);

    const conflicts = findPinConflicts(existingRows, "org", editedPackageNames);
    if (conflicts.length > 0) {
      return yield* Effect.fail(
        new PackagePinConflictError({
          error: {
            code: "pinned_entry_conflict",
            message: `${conflicts.length} package(s) are pinned above the org scope and cannot be overridden below.`,
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
        pinned: upsert.pinned !== undefined ? upsert.pinned : (previous?.pinned ?? false),
      };
    });

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
                pinned: upsert.pinned,
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
                  pinned: upsert.pinned,
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
        pinned: upsert.pinned,
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
          previous: previousByName.get(packageName) ?? null,
          current: currentByName.get(packageName) ?? null,
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
