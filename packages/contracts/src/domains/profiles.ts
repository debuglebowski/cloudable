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
}

export interface ProfilePackageEntry {
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  partOf: string | null;
  description: string | null;
  setting: PackageSetting;
}

export interface ProfileDetail extends ProfileSummary {
  /** The profile's own settings. What it does not set, its machines take from the org. */
  settings: Array<{ key: string; value: unknown; locked: boolean }>;
  /** The profile's own package entries. */
  packages: ProfilePackageEntry[];
}

export interface ListProfilesResponse {
  items: ProfileSummary[];
}

export interface CreateProfileRequest {
  name: string;
  description?: string | null;
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
export type UpdateProfileRequest = Partial<CreateProfileRequest>;
