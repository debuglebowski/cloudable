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
// created. They cannot change while a machine that is not archived uses the
// profile: a profile edit must never resize or move a live machine (invariant 10).
// To change them, make a new profile. See docs/inheritance.md.
// ---------------------------------------------------------------------------
import type { ProfileCreationFields, ProfileEvent } from "@cloudable/events";
import { machines, profiles, settingValues } from "@cloudable/schema";
import { and, asc, count, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { type Context, Effect } from "effect";
import { ulid } from "ulid";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { getCatalogEntry } from "../../services/CloudCatalogService";
import { EventBus } from "../../services/EventBus";
import { UBUNTU_IMAGES } from "../../services/ProvisioningService.azure";
import { type OrgPackageEntry, listProfilePackages } from "../organisation/packages";
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
  createdAt: string;
  archivedAt: string | null;
  /** Machines on this profile that are not archived. While above zero, creation fields are fixed. */
  machineCount: number;
}

export interface ProfileSettingView {
  key: string;
  value: unknown;
  locked: boolean;
}

export interface ProfileDetail extends ProfileView {
  /** The profile's own settings. What it does not set, its machines take from the org. */
  settings: ProfileSettingView[];
  /** The profile's own package entries. */
  packages: OrgPackageEntry[];
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
}

export interface CreateProfileInput extends ProfileFieldsInput {
  orgId: string;
  name: string;
  description?: string | null | undefined;
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

const toView = (row: ProfileRow, machineCount: number): ProfileView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  provider: row.provider,
  region: row.region,
  sizeSku: row.sizeSku,
  image: row.image,
  createdAt: row.createdAt.toISOString(),
  archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  machineCount,
});

const creationFieldsOf = (row: {
  provider: Provider | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
}): ProfileCreationFields => ({
  provider: row.provider,
  region: row.region,
  size: row.sizeSku,
  image: row.image,
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
  fields: { provider: Provider | null; region: string | null; sizeSku: string | null; image: string | null },
) =>
  Effect.gen(function* () {
    const invalid = (message: string) => editError("invalid_profile_field", message);
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
        Effect.mapError((cause) => new ProfileWriteError({ message: `reading catalog: ${String(cause)}` })),
      );
      if (!entry) return yield* invalid(`region "${region}" is not recognized`);
    }
    const requiredImage = image !== null ? UBUNTU_IMAGES[image] : undefined;
    if (image !== null && !requiredImage) return yield* invalid(`image "${image}" is not recognized`);
    if (sizeSku !== null) {
      const entry = yield* getCatalogEntry("azure", "sku", sizeSku).pipe(
        Effect.provideService(Db, db),
        Effect.mapError((cause) => new ProfileWriteError({ message: `reading catalog: ${String(cause)}` })),
      );
      if (!entry) return yield* invalid(`size "${sizeSku}" is not recognized`);
      if (requiredImage && entry.architecture && entry.architecture !== requiredImage.architecture) {
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

export const listProfiles = (
  orgId: string,
): Effect.Effect<ProfileView[], ProfileWriteError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* write("listing profiles", () =>
      db.select().from(profiles).where(eq(profiles.orgId, orgId)).orderBy(asc(profiles.name)),
    );
    const counts = yield* liveMachineCounts(
      db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toView(row, counts.get(row.id) ?? 0));
  });

export const getProfile = (
  orgId: string,
  profileId: string,
): Effect.Effect<ProfileDetail, ProfileError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* loadProfile(db, orgId, profileId);
    const counts = yield* liveMachineCounts(db, [row.id]);
    const settingRows = yield* write("reading profile settings", () =>
      db
        .select({ key: settingValues.key, value: settingValues.value, locked: settingValues.locked })
        .from(settingValues)
        .where(and(eq(settingValues.scopeType, "profile"), eq(settingValues.scopeId, row.id)))
        .orderBy(asc(settingValues.key)),
    );
    const packages = yield* listProfilePackages(orgId, row.id).pipe(
      Effect.mapError((cause) => new ProfileWriteError({ message: `reading packages: ${cause.reason}` })),
    );
    return {
      ...toView(row, counts.get(row.id) ?? 0),
      settings: settingRows.map((s) => ({ key: s.key, value: s.value, locked: s.locked })),
      packages,
    };
  });

export const createProfile = (
  input: CreateProfileInput,
): Effect.Effect<ProfileView, ProfileEditError | ProfileWriteError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const name = input.name.trim();
    if (name.length === 0) return yield* editError("invalid_profile_field", "a profile needs a name");
    const fields = {
      provider: input.provider ?? null,
      region: blankToNull(input.region) ?? null,
      sizeSku: blankToNull(input.sizeSku) ?? null,
      image: blankToNull(input.image) ?? null,
    };
    yield* validateCreationFields(db, fields);
    yield* requireNameFree(db, input.orgId, name);
    const description = blankToNull(input.description) ?? null;
    const rows = yield* write("creating profile", () =>
      db
        .insert(profiles)
        .values({ orgId: input.orgId, name, description, ...fields })
        .returning(),
    );
    const row = rows[0];
    if (!row) return yield* Effect.fail(new ProfileWriteError({ message: "creating profile: no row" }));
    yield* publish({
      ...envelope(input.orgId, input.actor),
      type: "profile.created",
      payload: { profileId: row.id, name, description, ...creationFieldsOf(row) },
    });
    return toView(row, 0);
  });

export const updateProfile = (
  input: UpdateProfileInput,
): Effect.Effect<ProfileView, ProfileError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* loadProfile(db, input.orgId, input.profileId);
    if (row.archivedAt !== null) {
      return yield* editError("profile_archived", `Profile "${row.name}" is archived and cannot change.`);
    }

    const next = {
      name: input.name !== undefined ? input.name.trim() : row.name,
      description:
        input.description !== undefined ? (blankToNull(input.description) ?? null) : row.description,
      provider: input.provider !== undefined ? input.provider : row.provider,
      region: input.region !== undefined ? (blankToNull(input.region) ?? null) : row.region,
      sizeSku: input.sizeSku !== undefined ? (blankToNull(input.sizeSku) ?? null) : row.sizeSku,
      image: input.image !== undefined ? (blankToNull(input.image) ?? null) : row.image,
    };
    if (next.name.length === 0) return yield* editError("invalid_profile_field", "a profile needs a name");

    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (key) => next[key] !== row[key],
    );
    const counts = yield* liveMachineCounts(db, [row.id]);
    const machineCount = counts.get(row.id) ?? 0;
    if (changed.length === 0) return toView(row, machineCount);

    const creationChanged = changed.filter((key) =>
      (["provider", "region", "sizeSku", "image"] as const).some((field) => field === key),
    );
    if (creationChanged.length > 0) {
      if (machineCount > 0) {
        return yield* editError(
          "profile_in_use",
          `${machineCount} machine(s) use profile "${row.name}", so its provider, region, size and image cannot change. Make a new profile instead.`,
        );
      }
      yield* validateCreationFields(db, next);
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
    return toView(updated[0] ?? row, machineCount);
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
    if (row.archivedAt !== null) return toView(row, counts.get(row.id) ?? 0);
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
    return toView(updated[0] ?? row, counts.get(row.id) ?? 0);
  });

/**
 * The profile a machine is being created on or moved to: this org's, not archived. Returns its
 * creation fields so the caller can fill in or check the machine's own.
 */
export const requireUsableProfile = (
  db: DbHandle,
  orgId: string,
  profileId: string,
): Effect.Effect<ProfileRow, ProfileNotFoundError | ProfileEditError | ProfileWriteError> =>
  Effect.gen(function* () {
    const row = yield* loadProfile(db, orgId, profileId);
    if (row.archivedAt !== null) {
      return yield* editError(
        "profile_archived",
        `Profile "${row.name}" is archived. No new machine can use it.`,
      );
    }
    return row;
  });

/**
 * Why a machine with these creation fields cannot be on this profile, or null when it can.
 * A field the profile leaves blank fits anything. A field the machine leaves blank (null) fits
 * too: on create, the profile fills it in.
 */
export const profileFieldConflict = (
  profile: Pick<ProfileRow, "name" | "provider" | "region" | "sizeSku" | "image">,
  machine: { provider: string | null; region: string | null; sizeSku: string | null; image: string | null },
): string | null => {
  const fields = [
    ["provider", profile.provider, machine.provider],
    ["region", profile.region, machine.region],
    ["size", profile.sizeSku, machine.sizeSku],
    ["image", profile.image, machine.image],
  ] as const;
  for (const [label, fromProfile, fromMachine] of fields) {
    if (fromProfile !== null && fromMachine !== null && fromProfile !== fromMachine) {
      return `profile "${profile.name}" sets ${label} to "${fromProfile}", not "${fromMachine}"`;
    }
  }
  return null;
};
