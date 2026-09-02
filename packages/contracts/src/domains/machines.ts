import type { PageInfo, PaginatedRequest } from "../common";

export type MachineState =
  | "provisioning"
  | "running"
  | "stopped"
  | "archived_restorable"
  | "archived_expired"
  | "error";

/** Where a resolved manifest entry's value came from — org → template → machine, lowest wins. */
export type ManifestScope = "org" | "template" | "machine";

export interface MachineSummary {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  region: string;
  sizeSku: string;
  image: string;
  state: MachineState;
  lastVerifiedAt: string | null; // ISO 8601, null until the agent's first check-in
  createdAt: string; // ISO 8601
}

export interface CreateMachineRequest {
  name: string;
  /** Optional — omitted, the control plane resolves the org's configured default region
   * instead of the caller always supplying one. */
  region?: string;
  sizeSku: string;
  image: string;
  /** A machine always has exactly one owner, always a person. */
  ownerPersonId: string;
  templateId?: string | null;
}

// `orgId`/`actorPersonId` are gone from every request below: the server
// derives both from the caller's session (`CurrentUserTag`), not the wire —
// see `apps/control-plane/src/http/middleware/auth.ts`.
export type ListMachinesRequest = PaginatedRequest;

export interface ListMachinesResponse {
  items: MachineSummary[];
  pageInfo: PageInfo;
}

/** A declared package manifest entry: a name and an optional version pin. No dependency resolution. */
export interface PackageManifestEntry {
  packageName: string;
  versionPin: string | null;
  pinned: boolean;
}

export interface ResolvedPackageManifestEntry extends PackageManifestEntry {
  /** Which scope level's row won resolution — feeds `LineageGutter`/`SettingRow` (docs/frontend.md). */
  source: ManifestScope;
  resolvedFromScopeId: string;
}

/**
 * A resolved org → template → machine setting, lowest level wins.
 * Shared wire shape for every single-value machine setting that
 * isn't a manifest entry — currently `persistentPaths` and
 * `accessMethodsEnabled` below. Written via the generic
 * `PATCH /api/v1/config/settings` endpoint (`packages/contracts/src/
 * domains/config.ts`'s `PatchSettingRequest`), read back here.
 */
export interface ResolvedMachineSetting<T> {
  value: T;
  source: ManifestScope;
  resolvedFromScopeId: string;
}

/** Disposable — persistent paths survive; the OS does not. A list of
 * absolute paths on the machine that survive an OS reimage/upgrade. */
export type PersistentPaths = string[];

/** Which of the two access methods are turned on for a machine. */
export interface AccessMethodsEnabled {
  webTerminal: boolean;
  ssh: boolean;
}

export interface MachineDetail extends MachineSummary {
  manifest: ResolvedPackageManifestEntry[];
  persistentPaths: ResolvedMachineSetting<PersistentPaths>;
  accessMethodsEnabled: ResolvedMachineSetting<AccessMethodsEnabled>;
}

/**
 * Edits are always applied at the `machine` scope (this endpoint edits one
 * machine's manifest). `upserts` add or replace a machine-level entry by
 * `packageName`; `removals` drop a machine-level override, falling back to
 * whatever the org/template chain resolves to. See `docs/inheritance.md`.
 */
export interface UpdateMachinePackagesRequest {
  upserts?: PackageManifestEntry[];
  removals?: string[];
}

export interface UpdateMachinePackagesResponse {
  manifest: ResolvedPackageManifestEntry[];
}

/** 422 body detail when an edit would override a pinned entry below its scope. */
export interface PackagePinConflict {
  packageName: string;
  pinnedAtScope: ManifestScope;
  pinnedAtScopeId: string;
  pinnedVersionPin: string | null;
}
