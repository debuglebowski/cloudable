// ---------------------------------------------------------------------------
// A profile's creation fields: provider, region, size and image.
//
// Each one is either a starting value or locked:
// - unlocked: the create form fills it in, and the machine may differ. The admin may change it
//   at any time. Existing machines never change (invariant 10).
// - locked: every machine on the profile must have this value. While a machine that is not
//   archived uses the profile, a locked field must match it, so it cannot change.
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

/** What a machine on `profile` gets for each creation field. */
export const resolveCreationFields = (profile: CreationFieldSource): ResolvedCreationFields => {
  const out = {} as ResolvedCreationFields;
  for (const field of CREATION_FIELDS) {
    const value = profile[field];
    out[field] =
      value !== null
        ? { value, locked: profile[LOCK_FLAG[field]], fromProfileId: profile.id }
        : { value: null, locked: false, fromProfileId: null };
  }
  return out;
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
