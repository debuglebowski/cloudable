// ---------------------------------------------------------------------------
// A profile's creation fields: provider, region, size and image.
//
// Each one is either a starting value or locked:
// - unlocked: the create form fills it in, and the machine may differ. The admin may change it
//   at any time. Existing machines never change (invariant 10).
// - locked: every machine on the profile must have this value. While a machine that is not
//   archived uses the profile, a locked field must match it, so it cannot change.
//
// A profile that extends a base takes each field it leaves blank from the base. Its own value
// wins over the base's, unless the base locks the field: then the base's value is the one, for
// the profile and every machine on it.
//
// See docs/inheritance.md.
// ---------------------------------------------------------------------------
import type { profiles } from "@cloudable/schema";

type ProfileRow = typeof profiles.$inferSelect;

export const CREATION_FIELDS = ["provider", "region", "sizeSku", "image"] as const;
export type CreationField = (typeof CREATION_FIELDS)[number];

export const LOCK_FLAG = {
  provider: "providerLocked",
  region: "regionLocked",
  sizeSku: "sizeLocked",
  image: "imageLocked",
} as const satisfies Record<CreationField, keyof ProfileRow>;
export type LockFlag = (typeof LOCK_FLAG)[CreationField];

/** The word a person reads, and the key recorded on events (`size`, not `sizeSku`). */
export const FIELD_LABEL = {
  provider: "provider",
  region: "region",
  sizeSku: "size",
  image: "image",
} as const satisfies Record<CreationField, string>;

export interface ResolvedCreationField {
  /** Null when no profile in the chain sets it: the create form asks for it. */
  value: string | null;
  /** Every machine on the profile must have `value`. */
  locked: boolean;
  /** The profile that set `value`, or null when none does. */
  fromProfileId: string | null;
}

export type ResolvedCreationFields = Record<CreationField, ResolvedCreationField>;

export type CreationFieldSource = Pick<
  ProfileRow,
  | "id"
  | "provider"
  | "region"
  | "sizeSku"
  | "image"
  | "providerLocked"
  | "regionLocked"
  | "sizeLocked"
  | "imageLocked"
>;

/**
 * What a machine on `profile` gets for each creation field. `base` is the profile it extends,
 * if any: a field the base locks is the base's; otherwise the profile's own value wins, and a
 * field it leaves blank comes from the base.
 */
export const resolveCreationFields = (
  profile: CreationFieldSource,
  base?: CreationFieldSource | null,
): ResolvedCreationFields => {
  const out = {} as ResolvedCreationFields;
  const own = (source: CreationFieldSource, field: CreationField): ResolvedCreationField | null => {
    const value = source[field];
    return value !== null
      ? { value, locked: source[LOCK_FLAG[field]], fromProfileId: source.id }
      : null;
  };
  for (const field of CREATION_FIELDS) {
    const fromBase = base ? own(base, field) : null;
    const fromProfile = own(profile, field);
    out[field] = (fromBase?.locked ? fromBase : (fromProfile ?? fromBase)) ?? {
      value: null,
      locked: false,
      fromProfileId: null,
    };
  }
  return out;
};

/** The resolved values alone, in the shape the validator and a machine row use. */
export const resolvedValues = (resolved: ResolvedCreationFields) => ({
  provider: resolved.provider.value as "azure" | "docker" | "fake" | null,
  region: resolved.region.value,
  sizeSku: resolved.sizeSku.value,
  image: resolved.image.value,
});

/**
 * Why `profile` cannot set its own creation fields under `base`, or null when it can: a field
 * the base locks cannot be given another value below it.
 */
export const baseLockConflict = (
  profile: Pick<CreationFieldSource, CreationField>,
  base: CreationFieldSource & { name: string },
): string | null => {
  for (const field of CREATION_FIELDS) {
    const baseValue = base[field];
    const ownValue = profile[field];
    if (
      base[LOCK_FLAG[field]] &&
      baseValue !== null &&
      ownValue !== null &&
      ownValue !== baseValue
    ) {
      return `base profile "${base.name}" locks the ${FIELD_LABEL[field]} at "${baseValue}", so it cannot be "${ownValue}" here`;
    }
  }
  return null;
};

export interface MachineCreationValues {
  provider: string | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
}

/**
 * Why a machine with these creation fields cannot be on a profile, or null when it can. Only a
 * locked field binds the machine. A field the machine leaves blank (null) fits too: on create,
 * the profile fills it in.
 */
export const lockedFieldConflict = (
  profileName: string,
  resolved: ResolvedCreationFields,
  machine: MachineCreationValues,
): string | null => {
  for (const field of CREATION_FIELDS) {
    const { value, locked } = resolved[field];
    const fromMachine = machine[field];
    if (locked && value !== null && fromMachine !== null && value !== fromMachine) {
      return `profile "${profileName}" locks the ${FIELD_LABEL[field]} at "${value}", not "${fromMachine}"`;
    }
  }
  return null;
};
