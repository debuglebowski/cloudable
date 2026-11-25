// Profiles: named sets of settings machines link to (org → profile → machine).
// Wire types for `/api/v1/profiles`. See docs/inheritance.md.
import type { MachineProvider, PackageSetting } from "./machines";

/** The creation fields a profile may set. */
export type ProfileCreationField = "provider" | "region" | "sizeSku" | "image";

/** What a machine created on a profile gets for one creation field. */
export interface ResolvedProfileCreationField {
  /** Null when no profile sets it: the create form asks for it. */
  value: string | null;
  /** Locked: every machine on the profile has this value. Unlocked: a starting value. */
  locked: boolean;
  /** The profile that set the value, or null when none does. */
  fromProfileId: string | null;
}

export interface ProfileSummary {
  id: string;
  name: string;
  description: string | null;
  /** The profile's own creation fields. Null means it does not set one. */
  provider: MachineProvider | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
  /** A locked field must match every machine on the profile. An unlocked one is a starting value. */
  providerLocked: boolean;
  regionLocked: boolean;
  sizeLocked: boolean;
  imageLocked: boolean;
  /** What a machine created on this profile gets. Use this to fill in the create form. */
  creation: Record<ProfileCreationField, ResolvedProfileCreationField>;
  createdAt: string;
  archivedAt: string | null;
  /** Machines on it that are not archived. A locked field must match all of them. */
  machineCount: number;
  /** The profile this one extends, or null. Its machines resolve org → base → profile → machine. */
  baseProfileId: string | null;
  baseProfileName: string | null;
  /** Profiles that are not archived and extend this one. While above zero, it cannot be archived. */
  extendedBy: number;
}

export interface ProfilePackageEntry {
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  partOf: string | null;
  description: string | null;
  setting: PackageSetting;
}

export interface ProfileSettingEntry {
  key: string;
  value: unknown;
  locked: boolean;
}

export interface ProfileDetail extends ProfileSummary {
  /** The profile's own settings. What it does not set, its machines take from its base or the org. */
  settings: ProfileSettingEntry[];
  /** The profile's own package entries. */
  packages: ProfilePackageEntry[];
  /** The base's own settings and packages: what this profile inherits from it. */
  base: {
    id: string;
    name: string;
    settings: ProfileSettingEntry[];
    packages: ProfilePackageEntry[];
  } | null;
}

export interface ListProfilesResponse {
  items: ProfileSummary[];
}

export interface CreateProfileRequest {
  name: string;
  description?: string | null;
  /** The profile to extend. Same org, not archived, and not extending another itself. */
  baseProfileId?: string | null;
  provider?: MachineProvider | null;
  region?: string | null;
  sizeSku?: string | null;
  image?: string | null;
  /** A lock needs a value. Clearing a value also unlocks it. */
  providerLocked?: boolean;
  regionLocked?: boolean;
  sizeLocked?: boolean;
  imageLocked?: boolean;
}

/**
 * Omitted keeps the field. Null clears it. An unlocked creation field can change at any time.
 * A locked one must still match every machine on the profile.
 */
export type UpdateProfileRequest = Partial<Omit<CreateProfileRequest, "baseProfileId">>;

/** `PUT /api/v1/profiles/:id/base`: extend another profile, or none (`null`). */
export interface SetProfileBaseRequest {
  baseProfileId: string | null;
}
