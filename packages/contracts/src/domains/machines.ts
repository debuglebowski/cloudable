import type { PageInfo, PaginatedRequest } from "../common";

/**
 * The single Unix user every Cloudable machine is provisioned with
 * (`ProvisioningService.azure.ts`'s `osProfile.adminUsername`).
 *
 * Shared rather than repeated because the CLI has to agree with the
 * provisioner exactly: `cloudable connect` hands this to `su` on the
 * machine, and `cloudable login` bakes it into the certificate's sole
 * principal. Both used to default to the *local* username instead, which
 * works only if your laptop account happens to be named the same as a user
 * on a VM you have never logged into — so `connect` failed with "su: user
 * kalle does not exist" for everyone whose account is not called
 * "cloudable".
 *
 * One machine, one owner, one OS user (invariant 3). There is no per-person
 * account to look up, so this is a constant and not a lookup.
 */
export const MACHINE_OS_USER = "cloudable";

export type MachineState =
  | "provisioning"
  | "running"
  | "stopped"
  | "archived_restorable"
  | "archived_expired"
  | "error";

/** Where a resolved manifest entry's value came from — org → template → machine, lowest wins. */
export type ManifestScope = "org" | "template" | "machine";

/** Which `ProvisioningService` backend a machine runs on — a per-machine,
 * org-enabled choice (see `docs/frontend.md`'s Integrations page). Not every
 * provider supports every field: only `"azure"` has regions, and only
 * `"azure"`'s image is a curated catalog rather than free text. */
export type MachineProvider = "azure" | "docker" | "fake";

export interface MachineSummary {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  provider: MachineProvider;
  /** `null` for providers with no region concept (docker/fake). */
  region: string | null;
  sizeSku: string;
  image: string;
  state: MachineState;
  lastVerifiedAt: string | null; // ISO 8601, null until the agent's first check-in
  createdAt: string; // ISO 8601
}

export interface CreateMachineRequest {
  /** Optional — a friendly, org-unique default is generated when omitted or blank. */
  name?: string;
  provider: MachineProvider;
  /** Required iff `provider === "azure"` (and must name one of the org's
   * enabled Azure regions) — omitted/ignored for every other provider. */
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
  /**
   * Machine scope only: this package must not be on this machine, overriding
   * the org. Different from having no entry, which means "inherit". An
   * excluded entry is not part of the declared install set, so a machine that
   * reports it installed drifts.
   */
  excluded: boolean;
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

/**
 * Which access methods are turned on for a machine. Admin-disablable at any level in the
 * org -> template -> machine chain, and disabling one terminates its live sessions
 * (`domain/config/apply-setting-change.ts`) rather than merely refusing new ones.
 *
 * `files` is a separate flag from `webTerminal` on purpose. It is the lower of the two
 * elevation levels in `docs/spec.md` §15 — file recovery cannot read injected secrets the
 * way an interactive shell can — so an admin can be granted file access to a machine they
 * do not own without also being granted a shell on it. Folding it into `webTerminal` would
 * collapse that distinction and leave `elevations.level = "file_recovery"` with nothing to
 * authorize.
 *
 * A stored value predating `files` simply lacks the key and falls back to
 * `DEFAULT_ACCESS_METHODS_ENABLED` (`apps/control-plane/src/domain/machine/settings.ts`),
 * so this addition needs no migration.
 */
export interface AccessMethodsEnabled {
  webTerminal: boolean;
  ssh: boolean;
  files: boolean;
}

export interface MachineDetail extends MachineSummary {
  manifest: ResolvedPackageManifestEntry[];
  persistentPaths: ResolvedMachineSetting<PersistentPaths>;
  accessMethodsEnabled: ResolvedMachineSetting<AccessMethodsEnabled>;
}

/**
 * One edit to one entry. Every field but the name is optional, and an omitted
 * field keeps whatever the machine's own existing row had rather than
 * resetting it — so excluding a package does not silently drop its version
 * pin, and re-pinning does not silently un-exclude it.
 */
export interface PackageManifestEdit {
  packageName: string;
  versionPin?: string | null;
  pinned?: boolean;
  excluded?: boolean;
}

/**
 * Edits are always applied at the `machine` scope (this endpoint edits one
 * machine's manifest). `upserts` add or replace a machine-level entry by
 * `packageName`; `removals` drop a machine-level override, falling back to
 * whatever the org/template chain resolves to. See `docs/inheritance.md`.
 *
 * Removal and exclusion are different things: removing drops this machine's
 * own row so the org's entry applies again, while excluding writes a row that
 * says the package must not be here at all.
 */
export interface UpdateMachinePackagesRequest {
  upserts?: PackageManifestEdit[];
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
