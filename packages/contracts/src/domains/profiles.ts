// Profiles: named sets of settings machines link to (org → profile → machine).
// Wire types for `/api/v1/profiles`. See docs/inheritance.md.
import type { MachineProvider, PackageSetting } from "./machines";

export interface ProfileSummary {
  id: string;
  name: string;
  description: string | null;
  /** Creation fields. Null means the create form asks for it. */
  provider: MachineProvider | null;
  region: string | null;
  sizeSku: string | null;
  image: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** Machines on it that are not archived. While above zero, creation fields cannot change. */
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
}

/** Omitted keeps the field. Null clears it. Creation fields change only while no machine uses it. */
export type UpdateProfileRequest = Partial<CreateProfileRequest>;
