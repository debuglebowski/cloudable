// ---------------------------------------------------------------------------
// Profiles: named sets of settings machines link to (org → profile → machine).
//
// A profile's settings and packages are ordinary `setting_values` /
// `machine_packages` rows with `scopeType: "profile"`, written through the same
// paths the org's are (`applySettingChange`, `updateOrgPackages` with a
// `profileId`). This module owns the profile row itself: its name, description,
// creation fields, and archiving.
//
// Creation fields (provider, region, size, image) are used only when a machine is
// created. An unlocked one is a starting value: it can change at any time, and
// existing machines keep theirs. A locked one must match every machine on the
// profile that is not archived, so it cannot change while one uses it. A profile
// edit never resizes or moves a live machine (invariant 10). See
// docs/inheritance.md and ./creation-fields.ts.
//
// A profile may extend one base profile in the same org (`baseProfileId`). The chain is then
// org → base → profile → machine, for settings, packages and creation fields alike. One level
// only: a base has no base of its own, and a profile that is a base cannot get one.
// ---------------------------------------------------------------------------
import type {
  ProfileCreationFieldLocks,
  ProfileCreationFields,
  ProfileEvent,
} from "@cloudable/events";
import { machinePackages, machines, profiles, settingValues } from "@cloudable/schema";
import { and, asc, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { type Context, Effect } from "effect";
import { ulid } from "ulid";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { getCatalogEntry } from "../../services/CloudCatalogService";
import { EventBus } from "../../services/EventBus";
import { UBUNTU_IMAGES } from "../../services/ProvisioningService.azure";
import { type OrgPackageEntry, listProfilePackages } from "../organisation/packages";
import {
  CREATION_FIELDS,
  type CreationField,
  FIELD_LABEL,
  LOCK_FLAG,
  type ResolvedCreationFields,
  baseLockConflict,
  lockedFieldConflict,
  resolveCreationFields,
  resolvedValues,
} from "./creation-fields";
import { ProfileEditError, ProfileNotFoundError, ProfileWriteError } from "./errors";

type DbHandle = Context.Tag.Service<typeof Db>;
type ProfileRow = typeof profiles.$inferSelect;
type Provider = "azure" | "docker" | "fake";

const ARCHIVED_MACHINE_STATES = ["archived_restorable", "archived_expired"] as const;

export interface ProfileView {
  id: string;
  name: string;
  description: string | null;
  provider: Provider | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
  providerLocked: boolean;
  regionLocked: boolean;
  sizeLocked: boolean;
  imageLocked: boolean;
  /** What a machine created on this profile gets for each creation field, and which are locked. */
  creation: ResolvedCreationFields;
  createdAt: string;
  archivedAt: string | null;
  /** Machines on this profile that are not archived. A locked creation field must match them. */
  machineCount: number;
  /** The profile this one extends, or null. */
  baseProfileId: string | null;
  baseProfileName: string | null;
  /** Profiles that are not archived and extend this one. While above zero, it cannot be archived. */
  extendedBy: number;
}

export interface ProfileSettingView {
  key: string;
  value: unknown;
  locked: boolean;
}

export interface ProfileDetail extends ProfileView {
  /** The profile's own settings. What it does not set, its machines take from its base or the org. */
  settings: ProfileSettingView[];
  /** The profile's own package entries. */
  packages: OrgPackageEntry[];
  /** The base's own settings and packages: what this profile inherits from it. */
  base: {
    id: string;
    name: string;
    settings: ProfileSettingView[];
    packages: OrgPackageEntry[];
  } | null;
}

export interface ProfileActor {
  actorType: "person" | "system";
  actorId: string;
}

export interface ProfileFieldsInput {
  provider?: Provider | null | undefined;
  region?: string | null | undefined;
  sizeSku?: string | null | undefined;
  image?: string | null | undefined;
  providerLocked?: boolean | undefined;
  regionLocked?: boolean | undefined;
  sizeLocked?: boolean | undefined;
  imageLocked?: boolean | undefined;
}

export interface CreateProfileInput extends ProfileFieldsInput {
  orgId: string;
  name: string;
  description?: string | null | undefined;
  /** The profile it extends. Same org, not archived, and not itself extending another. */
  baseProfileId?: string | null | undefined;
  actor: ProfileActor;
}

export interface UpdateProfileInput extends ProfileFieldsInput {
  orgId: string;
  profileId: string;
  name?: string | undefined;
  description?: string | null | undefined;
  actor: ProfileActor;
}

type ProfileError = ProfileNotFoundError | ProfileEditError | ProfileWriteError;

const write = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ProfileWriteError({ message: `${message}: ${String(cause)}` }),
  });

const editError = (code: ProfileEditError["code"], message: string) =>
  Effect.fail(new ProfileEditError({ code, message }));

const blankToNull = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

interface ViewContext {
  base: ProfileRow | null;
  extendedBy: number;
}

const toView = (
  row: ProfileRow,
  machineCount: number,
  context: ViewContext = { base: null, extendedBy: 0 },
): ProfileView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  provider: row.provider,
  region: row.region,
  sizeSku: row.sizeSku,
  image: row.image,
  providerLocked: row.providerLocked,
  regionLocked: row.regionLocked,
  sizeLocked: row.sizeLocked,
  imageLocked: row.imageLocked,
  creation: resolveCreationFields(row, context.base),
  createdAt: row.createdAt.toISOString(),
  archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  machineCount,
  baseProfileId: row.baseProfileId,
  baseProfileName: context.base?.name ?? null,
  extendedBy: context.extendedBy,
});

const creationFieldsOf = (
  row: Pick<ProfileRow, CreationField | (typeof LOCK_FLAG)[CreationField]>,
): ProfileCreationFields & ProfileCreationFieldLocks => ({
  provider: row.provider,
  region: row.region,
  size: row.sizeSku,
  image: row.image,
  providerLocked: row.providerLocked,
  regionLocked: row.regionLocked,
  sizeLocked: row.sizeLocked,
  imageLocked: row.imageLocked,
});

type FieldValues = Pick<ProfileRow, CreationField | (typeof LOCK_FLAG)[CreationField]>;

/**
 * The creation fields and locks after an edit: each value the input names replaces the
 * current one, blank reads as none. A lock needs a value, so clearing a value also unlocks
 * it, and asking to lock a field with no value is refused.
 */
const nextFieldValues = (
  current: FieldValues | null,
  input: ProfileFieldsInput,
): Effect.Effect<FieldValues, ProfileEditError> =>
  Effect.gen(function* () {
    const next = {} as Record<string, unknown>;
    for (const field of CREATION_FIELDS) {
      const given = input[field];
      const value =
        given !== undefined
          ? field === "provider"
            ? given
            : (blankToNull(given as string | null) ?? null)
          : (current?.[field] ?? null);
      const flag = LOCK_FLAG[field];
      const askedLock = input[flag];
      if (askedLock === true && value === null) {
        return yield* editError(
          "invalid_profile_field",
          `set a ${FIELD_LABEL[field]} before locking it`,
        );
      }
      next[field] = value;
      next[flag] = value === null ? false : (askedLock ?? current?.[flag] ?? false);
    }
    return next as FieldValues;
  });

const loadProfile = (db: DbHandle, orgId: string, profileId: string) =>
  Effect.gen(function* () {
    const rows = yield* write("reading profile", () =>
      db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1),
    );
    const row = rows[0];
    if (!row || row.orgId !== orgId) {
      return yield* Effect.fail(new ProfileNotFoundError({ profileId }));
    }
    return row;
  });

/** The base `row` extends, or null. */
const loadBase = (db: DbHandle, row: ProfileRow) =>
  Effect.gen(function* () {
    if (!row.baseProfileId) return null;
    const baseId = row.baseProfileId;
    const rows = yield* write("reading base profile", () =>
      db.select().from(profiles).where(eq(profiles.id, baseId)).limit(1),
    );
    return rows[0] ?? null;
  });

/** Every profile that extends `profileId`, archived or not. */
const loadChildren = (db: DbHandle, profileId: string) =>
  write("reading profiles that extend it", () =>
    db.select().from(profiles).where(eq(profiles.baseProfileId, profileId)),
  );

/** The view of one profile, with its base and how many live profiles extend it. */
const viewOf = (db: DbHandle, row: ProfileRow) =>
  Effect.gen(function* () {
    const counts = yield* liveMachineCounts(db, [row.id]);
    const base = yield* loadBase(db, row);
    const children = yield* loadChildren(db, row.id);
    return toView(row, counts.get(row.id) ?? 0, {
      base,
      extendedBy: children.filter((child) => child.archivedAt === null).length,
    });
  });

const liveMachineCounts = (db: DbHandle, profileIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (profileIds.length === 0) return new Map<string, number>();
    const rows = yield* write("counting machines", () =>
      db
        .select({ profileId: machines.profileId, n: count() })
        .from(machines)
        .where(
          and(
            inArray(machines.profileId, [...profileIds]),
            notInArray(machines.state, [...ARCHIVED_MACHINE_STATES]),
          ),
        )
        .groupBy(machines.profileId),
    );
    return new Map(rows.map((row) => [row.profileId ?? "", Number(row.n)]));
  });

/**
 * Checks the creation fields a profile sets, so a bad value is refused when the
 * profile is saved, not later when someone tries to create a machine from it.
 * Machine creation checks them again in full (`MachineService.create`).
 */
const validateCreationFields = (
  db: DbHandle,
  fields: {
    provider: Provider | null;
    region: string | null;
    sizeSku: string | null;
    image: string | null;
  },
  /** Names the profile in the message when it is not the one being edited. */
  about?: string,
) =>
  Effect.gen(function* () {
    const invalid = (message: string) =>
      editError("invalid_profile_field", about ? `${about}: ${message}` : message);
    const { provider, region, sizeSku, image } = fields;
    if (provider === null) {
      if (region !== null || sizeSku !== null || image !== null) {
        return yield* invalid("set a provider before a region, size or image");
      }
      return;
    }
    if (provider !== "azure") {
      if (region !== null) return yield* invalid(`provider "${provider}" has no region`);
      return;
    }
    if (region !== null && !config.azureMachinesLocation) {
      const entry = yield* getCatalogEntry("azure", "region", region).pipe(
        Effect.provideService(Db, db),
        Effect.mapError(
          (cause) => new ProfileWriteError({ message: `reading catalog: ${String(cause)}` }),
        ),
      );
      if (!entry) return yield* invalid(`region "${region}" is not recognized`);
    }
    const requiredImage = image !== null ? UBUNTU_IMAGES[image] : undefined;
    if (image !== null && !requiredImage)
      return yield* invalid(`image "${image}" is not recognized`);
    if (sizeSku !== null) {
      const entry = yield* getCatalogEntry("azure", "sku", sizeSku).pipe(
        Effect.provideService(Db, db),
        Effect.mapError(
          (cause) => new ProfileWriteError({ message: `reading catalog: ${String(cause)}` }),
        ),
      );
      if (!entry) return yield* invalid(`size "${sizeSku}" is not recognized`);
      if (
        requiredImage &&
        entry.architecture &&
        entry.architecture !== requiredImage.architecture
      ) {
        return yield* invalid(
          `size "${sizeSku}" (${entry.architecture}) is not compatible with image "${image}" (requires ${requiredImage.architecture})`,
        );
      }
    }
  });

const requireNameFree = (db: DbHandle, orgId: string, name: string, exceptId?: string) =>
  Effect.gen(function* () {
    const rows = yield* write("checking name", () =>
      db
        .select({ id: profiles.id })
        .from(profiles)
        .where(and(eq(profiles.orgId, orgId), eq(profiles.name, name)))
        .limit(1),
    );
    const taken = rows[0];
    if (taken && taken.id !== exceptId) {
      return yield* editError(
        "profile_name_taken",
        `A profile named "${name}" already exists. Archived profiles keep their names.`,
      );
    }
  });

const envelope = (orgId: string, actor: ProfileActor) => ({
  id: "",
  occurredAt: new Date(),
  recordedAt: new Date(0),
  orgId,
  actorType: actor.actorType,
  actorId: actor.actorId,
  machineId: null,
  correlationId: ulid(),
  schemaVersion: 1,
});

const publish = (event: ProfileEvent) =>
  Effect.flatMap(EventBus, (eventBus) =>
    eventBus
      .publish([event])
      .pipe(
        Effect.mapError(
          (cause) => new ProfileWriteError({ message: `publishing event: ${cause.reason}` }),
        ),
      ),
  );

export const listProfiles = (orgId: string): Effect.Effect<ProfileView[], ProfileWriteError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* write("listing profiles", () =>
      db.select().from(profiles).where(eq(profiles.orgId, orgId)).orderBy(asc(profiles.name)),
    );
    const counts = yield* liveMachineCounts(
      db,
      rows.map((row) => row.id),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows.map((row) =>
      toView(row, counts.get(row.id) ?? 0, {
        base: row.baseProfileId ? (byId.get(row.baseProfileId) ?? null) : null,
        extendedBy: rows.filter((child) => child.baseProfileId === row.id && !child.archivedAt)
          .length,
      }),
    );
  });

const ownSettings = (db: DbHandle, profileId: string) =>
  Effect.map(
    write("reading profile settings", () =>
      db
        .select({
          key: settingValues.key,
          value: settingValues.value,
          locked: settingValues.locked,
        })
        .from(settingValues)
        .where(and(eq(settingValues.scopeType, "profile"), eq(settingValues.scopeId, profileId)))
        .orderBy(asc(settingValues.key)),
    ),
    (rows) => rows.map((s) => ({ key: s.key, value: s.value, locked: s.locked })),
  );

const ownPackages = (orgId: string, profileId: string) =>
  listProfilePackages(orgId, profileId).pipe(
    Effect.mapError(
      (cause) => new ProfileWriteError({ message: `reading packages: ${cause.reason}` }),
    ),
  );

export const getProfile = (
  orgId: string,
  profileId: string,
): Effect.Effect<ProfileDetail, ProfileError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* loadProfile(db, orgId, profileId);
    const view = yield* viewOf(db, row);
    const baseRow = yield* loadBase(db, row);
    return {
      ...view,
      settings: yield* ownSettings(db, row.id),
      packages: yield* ownPackages(orgId, row.id),
      base: baseRow
        ? {
            id: baseRow.id,
            name: baseRow.name,
            settings: yield* ownSettings(db, baseRow.id),
            packages: yield* ownPackages(orgId, baseRow.id),
          }
        : null,
    };
  });

/**
 * The base a profile may extend: this org's, not archived, and not extending another itself.
 * `forProfileId` is the profile that would extend it, when it exists already.
 */
const requireUsableBase = (
  db: DbHandle,
  orgId: string,
  baseProfileId: string,
  forProfileId?: string,
) =>
  Effect.gen(function* () {
    const invalid = (message: string) => editError("invalid_base_profile", message);
    if (baseProfileId === forProfileId) return yield* invalid("a profile cannot extend itself");
    const rows = yield* write("reading base profile", () =>
      db.select().from(profiles).where(eq(profiles.id, baseProfileId)).limit(1),
    );
    const base = rows[0];
    if (!base || base.orgId !== orgId) {
      return yield* invalid("the base must be one of this org's profiles");
    }
    if (base.archivedAt !== null) {
      return yield* invalid(`Profile "${base.name}" is archived. No profile can extend it now.`);
    }
    if (base.baseProfileId !== null) {
      return yield* invalid(
        `Profile "${base.name}" extends another profile itself. A profile can extend only a profile that extends nothing.`,
      );
    }
    return base;
  });

export const createProfile = (
  input: CreateProfileInput,
): Effect.Effect<ProfileView, ProfileEditError | ProfileWriteError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const name = input.name.trim();
    if (name.length === 0)
      return yield* editError("invalid_profile_field", "a profile needs a name");
    const fields = yield* nextFieldValues(null, input);
    const base = input.baseProfileId
      ? yield* requireUsableBase(db, input.orgId, input.baseProfileId)
      : null;
    if (base) {
      const conflict = baseLockConflict(fields, base);
      if (conflict) return yield* editError("invalid_profile_field", conflict);
    }
    yield* validateCreationFields(
      db,
      resolvedValues(resolveCreationFields({ id: "", ...fields }, base)),
    );
    yield* requireNameFree(db, input.orgId, name);
    const description = blankToNull(input.description) ?? null;
    const rows = yield* write("creating profile", () =>
      db
        .insert(profiles)
        .values({
          orgId: input.orgId,
          name,
          description,
          baseProfileId: base?.id ?? null,
          ...fields,
        })
        .returning(),
    );
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(new ProfileWriteError({ message: "creating profile: no row" }));
    yield* publish({
      ...envelope(input.orgId, input.actor),
      type: "profile.created",
      payload: {
        profileId: row.id,
        name,
        description,
        ...creationFieldsOf(row),
        ...(base ? { baseProfileId: base.id } : {}),
      },
    });
    return toView(row, 0, { base, extendedBy: 0 });
  });

export const updateProfile = (
  input: UpdateProfileInput,
): Effect.Effect<ProfileView, ProfileError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* loadProfile(db, input.orgId, input.profileId);
    if (row.archivedAt !== null) {
      return yield* editError(
        "profile_archived",
        `Profile "${row.name}" is archived and cannot change.`,
      );
    }

    const fields = yield* nextFieldValues(row, input);
    const next = {
      name: input.name !== undefined ? input.name.trim() : row.name,
      description:
        input.description !== undefined
          ? (blankToNull(input.description) ?? null)
          : row.description,
      ...fields,
    };
    if (next.name.length === 0)
      return yield* editError("invalid_profile_field", "a profile needs a name");

    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (key) => next[key] !== row[key],
    );
    const counts = yield* liveMachineCounts(db, [row.id]);
    const machineCount = counts.get(row.id) ?? 0;
    if (changed.length === 0) return toView(row, machineCount);

    const base = yield* loadBase(db, row);
    const children = yield* loadChildren(db, row.id);
    const nextRow = { ...row, ...fields };
    const creationChanged = CREATION_FIELDS.some(
      (field) => changed.includes(field) || changed.includes(LOCK_FLAG[field]),
    );
    if (creationChanged) {
      // A field the base locks cannot be given another value here.
      if (base) {
        const conflict = baseLockConflict(fields, base);
        if (conflict) return yield* editError("invalid_profile_field", conflict);
      }
      yield* validateCreationFields(db, resolvedValues(resolveCreationFields(nextRow, base)));
      // Profiles that extend this one take its fields too. A field it locks cannot differ on
      // them, and what they end up with must still make sense.
      for (const child of children) {
        const conflict = baseLockConflict(child, { ...nextRow, name: next.name });
        if (conflict) {
          return yield* editError(
            "profile_in_use",
            `Profile "${child.name}" extends this one and sets its own value: ${conflict}.`,
          );
        }
        yield* validateCreationFields(
          db,
          resolvedValues(resolveCreationFields(child, nextRow)),
          `profile "${child.name}", which extends this one`,
        );
      }
      // A locked field must match every machine on the profile, and on the profiles that
      // extend it. Changing an unlocked one is always allowed: it is only where the create
      // form starts, and no machine changes.
      yield* requireLocksMatchMachines(db, [
        { profile: row, resolved: resolveCreationFields(nextRow, base) },
        ...children.map((child) => ({
          profile: child,
          resolved: resolveCreationFields(child, nextRow),
        })),
      ]);
    }
    if (changed.includes("name")) yield* requireNameFree(db, input.orgId, next.name, row.id);

    const updated = yield* write("updating profile", () =>
      db
        .update(profiles)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(profiles.id, row.id))
        .returning(),
    );
    const previous: Record<string, unknown> = {};
    const current: Record<string, unknown> = {};
    for (const key of changed) {
      const label = key === "sizeSku" ? "size" : key;
      previous[label] = row[key];
      current[label] = next[key];
    }
    yield* publish({
      ...envelope(input.orgId, input.actor),
      type: "profile.updated",
      payload: { profileId: row.id, previous, current },
    });
    return toView(updated[0] ?? row, machineCount, {
      base,
      extendedBy: children.filter((child) => child.archivedAt === null).length,
    });
  });

/**
 * Refuses an edit that would leave a locked creation field different from a machine on the
 * profile that is not archived. Such a machine was created, or moved here, under other rules,
 * and a profile edit never changes a machine (invariant 10). Each entry is one profile and
 * what its machines would get.
 */
const requireLocksMatchMachines = (
  db: DbHandle,
  entries: ReadonlyArray<{ profile: ProfileRow; resolved: ResolvedCreationFields }>,
) =>
  Effect.forEach(entries, ({ profile, resolved }) => requireLocksMatch(db, profile, resolved), {
    discard: true,
  });

const requireLocksMatch = (db: DbHandle, profile: ProfileRow, resolved: ResolvedCreationFields) =>
  Effect.gen(function* () {
    const lockedFields = CREATION_FIELDS.filter((field) => resolved[field].locked);
    if (lockedFields.length === 0) return;
    const live = yield* write("reading machines", () =>
      db
        .select({
          provider: machines.provider,
          region: machines.region,
          sizeSku: machines.sizeSku,
          image: machines.image,
        })
        .from(machines)
        .where(
          and(
            eq(machines.profileId, profile.id),
            notInArray(machines.state, [...ARCHIVED_MACHINE_STATES]),
          ),
        ),
    );
    for (const field of lockedFields) {
      const value = resolved[field].value;
      const differing = live.filter((machine) => machine[field] !== value).length;
      if (differing > 0) {
        return yield* editError(
          "profile_in_use",
          `${differing} machine(s) on profile "${profile.name}" have a different ${FIELD_LABEL[field]}. A locked ${FIELD_LABEL[field]} must match every machine on the profile. Leave it unlocked, or move those machines first.`,
        );
      }
    }
  });

/**
 * Archives a profile. No new machine can use it. Machines already on it keep reading their
 * settings from it: archiving a profile must not change any machine (invariant 10). An admin
 * who wants them off it moves them one by one, each move recorded.
 */
export const archiveProfile = (input: {
  orgId: string;
  profileId: string;
  actor: ProfileActor;
}): Effect.Effect<ProfileView, ProfileError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* loadProfile(db, input.orgId, input.profileId);
    const counts = yield* liveMachineCounts(db, [row.id]);
    const base = yield* loadBase(db, row);
    if (row.archivedAt !== null)
      return toView(row, counts.get(row.id) ?? 0, { base, extendedBy: 0 });
    // A profile that others extend stays: they read their settings through it. Move them off
    // it first.
    const extending = (yield* loadChildren(db, row.id)).filter(
      (child) => child.archivedAt === null,
    );
    if (extending.length > 0) {
      return yield* editError(
        "profile_is_base",
        `${extending.map((child) => `"${child.name}"`).join(", ")} extend${extending.length === 1 ? "s" : ""} profile "${row.name}", so it cannot be archived. Change their base first.`,
      );
    }
    const updated = yield* write("archiving profile", () =>
      db
        .update(profiles)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(profiles.id, row.id), isNull(profiles.archivedAt)))
        .returning(),
    );
    yield* publish({
      ...envelope(input.orgId, input.actor),
      type: "profile.archived",
      payload: { profileId: row.id, name: row.name },
    });
    return toView(updated[0] ?? row, counts.get(row.id) ?? 0, { base, extendedBy: 0 });
  });

export interface SetBaseProfileInput {
  orgId: string;
  profileId: string;
  /** Null: extend nothing. */
  baseProfileId: string | null;
  actor: ProfileActor;
}

/**
 * Sets the profile `profileId` extends, or clears it. Recorded as `profile.base_changed`.
 *
 * Refused when the result would be more than one level, when the profile itself sets a
 * setting, package or creation field the new base locks, and when a machine on the profile
 * does not have a creation field the new base locks. Clearing is always allowed.
 *
 * Machines on the profile then resolve through the new base. The base's Ensure packages are
 * installed on them with no new approval: they were approved when they were set, the same as
 * when a machine moves onto a profile.
 */
export const setBaseProfile = (
  input: SetBaseProfileInput,
): Effect.Effect<ProfileView, ProfileError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* loadProfile(db, input.orgId, input.profileId);
    if (row.archivedAt !== null) {
      return yield* editError(
        "profile_archived",
        `Profile "${row.name}" is archived and cannot change.`,
      );
    }
    if (row.baseProfileId === input.baseProfileId) return yield* viewOf(db, row);

    const base =
      input.baseProfileId !== null
        ? yield* requireUsableBase(db, input.orgId, input.baseProfileId, row.id)
        : null;
    if (base) {
      const children = yield* loadChildren(db, row.id);
      if (children.length > 0) {
        return yield* editError(
          "invalid_base_profile",
          `${children.map((child) => `"${child.name}"`).join(", ")} extend${children.length === 1 ? "s" : ""} profile "${row.name}". A profile that is a base cannot extend another.`,
        );
      }
      const fieldConflict = baseLockConflict(row, base);
      if (fieldConflict) return yield* editError("invalid_base_profile", fieldConflict);
      const lockedSettings = yield* lockedOverrides(db, row.id, base.id);
      if (lockedSettings.length > 0) {
        return yield* editError(
          "invalid_base_profile",
          `Profile "${base.name}" locks ${lockedSettings.map((key) => `"${key}"`).join(", ")}, and profile "${row.name}" sets its own. Clear those here first.`,
        );
      }
      const resolved = resolveCreationFields(row, base);
      yield* validateCreationFields(db, resolvedValues(resolved));
      yield* requireLocksMatch(db, row, resolved);
    }

    const updated = yield* write("setting the base profile", () =>
      db
        .update(profiles)
        .set({ baseProfileId: base?.id ?? null, updatedAt: new Date() })
        .where(eq(profiles.id, row.id))
        .returning(),
    );
    // The allowed list the agent is sent may change with the base.
    yield* write("notifying machines", () =>
      db
        .update(machines)
        .set({ desiredStateVersion: sql`${machines.desiredStateVersion} + 1` })
        .where(
          and(
            eq(machines.profileId, row.id),
            notInArray(machines.state, [...ARCHIVED_MACHINE_STATES]),
          ),
        ),
    );
    yield* publish({
      ...envelope(input.orgId, input.actor),
      type: "profile.base_changed",
      payload: {
        profileId: row.id,
        previousBaseProfileId: row.baseProfileId,
        baseProfileId: base?.id ?? null,
      },
    });
    return yield* viewOf(db, updated[0] ?? row);
  });

/**
 * The setting keys and packages (`package:<name>`) `profileId` sets itself that `baseId`
 * locks. A base lock binds the profiles below it, so these block extending it.
 */
const lockedOverrides = (db: DbHandle, profileId: string, baseId: string) =>
  Effect.gen(function* () {
    const settings = yield* write("reading settings", () =>
      db
        .select({
          scopeId: settingValues.scopeId,
          key: settingValues.key,
          locked: settingValues.locked,
        })
        .from(settingValues)
        .where(
          and(
            eq(settingValues.scopeType, "profile"),
            inArray(settingValues.scopeId, [profileId, baseId]),
          ),
        ),
    );
    const packages = yield* write("reading packages", () =>
      db
        .select({
          scopeId: machinePackages.scopeId,
          key: machinePackages.packageName,
          locked: machinePackages.locked,
        })
        .from(machinePackages)
        .where(
          and(
            eq(machinePackages.scopeType, "profile"),
            inArray(machinePackages.scopeId, [profileId, baseId]),
          ),
        ),
    );
    const conflicts = (rows: ReadonlyArray<{ scopeId: string; key: string; locked: boolean }>) => {
      const own = new Set(rows.filter((r) => r.scopeId === profileId).map((r) => r.key));
      return rows
        .filter((r) => r.scopeId === baseId && r.locked && own.has(r.key))
        .map((r) => r.key);
    };
    return [...conflicts(settings), ...conflicts(packages).map((name) => `package:${name}`)];
  });

/**
 * The profile a machine is being created on or moved to: this org's, not archived. Returns its
 * creation fields so the caller can fill in or check the machine's own.
 */
export const requireUsableProfile = (
  db: DbHandle,
  orgId: string,
  profileId: string,
): Effect.Effect<UsableProfile, ProfileNotFoundError | ProfileEditError | ProfileWriteError> =>
  Effect.gen(function* () {
    const row = yield* loadProfile(db, orgId, profileId);
    if (row.archivedAt !== null) {
      return yield* editError(
        "profile_archived",
        `Profile "${row.name}" is archived. No new machine can use it.`,
      );
    }
    const base = yield* loadBase(db, row);
    return { ...row, creation: resolveCreationFields(row, base) };
  });

/** A profile a machine may be created on or moved to, with what its machines get. */
export type UsableProfile = ProfileRow & { creation: ResolvedCreationFields };

/**
 * Why a machine with these creation fields cannot be on this profile, or null when it can.
 * Only a locked field binds the machine, whether the profile or its base locks it. See
 * `lockedFieldConflict`.
 */
export const profileFieldConflict = (
  profile: UsableProfile,
  machine: {
    provider: string | null;
    region: string | null;
    sizeSku: string | null;
    image: string | null;
  },
): string | null => lockedFieldConflict(profile.name, profile.creation, machine);
