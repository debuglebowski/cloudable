import {
  type PackageSetting,
  isInstallablePackageName,
  isValidVersionPin,
  parseDeclaredPackageName,
} from "@cloudable/contracts";
import { type SettingRow, resolveSetting } from "@cloudable/schema";

/** See `docs/inheritance.md` for the full write-up of this chain. */
export type ManifestScope = "org" | "profile" | "machine";

export interface ManifestScopeChain {
  orgId: string;
  profileId?: string | null;
  machineId: string;
}

/** Mirrors the `machine_packages` table row shape (`packages/schema/src/tables/machine-package.ts`). */
export interface MachinePackageRow {
  scopeType: ManifestScope;
  scopeId: string;
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  /** Machine scope only — see the column comment in `machine-package.ts`. */
  excluded: boolean;
  /** See the column comment in `machine-package.ts`. Absent reads as null. */
  partOf?: string | null;
  /** Free text: why it is allowed. Absent reads as null. */
  description?: string | null;
  /** See the column comment in `machine-package.ts`. Absent reads as `allowed`. */
  setting?: PackageSetting;
  source: ManifestScope;
}

export interface PackageManifestValue {
  versionPin: string | null;
  locked: boolean;
  excluded: boolean;
  partOf: string | null;
  description: string | null;
  setting: PackageSetting;
}

export interface ResolvedManifestEntry {
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  /**
   * The winning row says this package must not be on the machine. Resolved
   * entries keep it (rather than being dropped here) so the console can
   * render an excluded row and offer to restore it; callers that want the
   * effective install set go through `declaredPackages`.
   */
  excluded: boolean;
  /** The parent declaration, null for an ordinary entry. */
  partOf: string | null;
  /** Why it is allowed, in a person's words; null when not given. */
  description: string | null;
  /** What Cloudable does about it: only allow it, or ensure it. */
  setting: PackageSetting;
  /** Which scope level's row won resolution — feeds `LineageGutter`/`SettingRow` (docs/frontend.md). */
  source: ManifestScope;
  resolvedFromScopeId: string;
}

/**
 * Resolve the effective package manifest for a machine across the
 * org → profile → machine chain (lowest level wins).
 *
 * Deliberately does not reimplement the chain walk: each distinct
 * `packageName` across `rows` is resolved individually via
 * `resolveSetting()` from `@cloudable/schema` (the same function
 * `settingValues` resolution uses), treating the package name as the
 * setting key. See `docs/inheritance.md`.
 */
export function resolveManifest(
  rows: ReadonlyArray<MachinePackageRow>,
  chain: ManifestScopeChain,
): ResolvedManifestEntry[] {
  const packageNames = new Set(rows.map((row) => row.packageName));
  const settingRows: ReadonlyArray<SettingRow<PackageManifestValue>> = rows.map((row) => ({
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    key: row.packageName,
    value: {
      versionPin: row.versionPin,
      locked: row.locked,
      excluded: row.excluded,
      partOf: row.partOf ?? null,
      description: row.description ?? null,
      setting: row.setting ?? "allowed",
    },
    source: row.source,
  }));

  const resolved: ResolvedManifestEntry[] = [];
  for (const packageName of packageNames) {
    const winner = resolveSetting(packageName, settingRows, chain);
    if (!winner) continue;
    resolved.push({
      packageName,
      versionPin: winner.value.versionPin,
      locked: winner.value.locked,
      excluded: winner.value.excluded,
      partOf: winner.value.partOf,
      description: winner.value.description,
      setting: winner.value.setting,
      source: winner.source,
      resolvedFromScopeId: winner.resolvedFromScopeId,
    });
  }
  return resolved.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/**
 * The effective install set: the resolved entries minus the excluded ones.
 *
 * `resolveManifest` deliberately keeps excluded entries so the console can
 * show them, so every caller that means "what should be on this machine"
 * — the reconcile loop's desired state, allowlist detection — goes through
 * here instead of reading the resolved list directly. An excluded package
 * is therefore *not* declared: if it turns up installed, it reads as
 * undeclared software, which is the whole point of excluding it.
 */
export function declaredPackages(
  manifest: ReadonlyArray<ResolvedManifestEntry>,
): ResolvedManifestEntry[] {
  const allowed = allowedPackageNames(manifest);
  return manifest.filter((entry) => allowed.has(entry.packageName));
}

/**
 * The names the manifest actually allows: not excluded, and, for a part,
 * only while its parent is allowed. A part whose parent is missing, excluded
 * or itself orphaned is not allowed. A cycle of parts allows nothing.
 */
export function allowedPackageNames(
  manifest: ReadonlyArray<Pick<ResolvedManifestEntry, "packageName" | "excluded" | "partOf">>,
): Set<string> {
  const byName = new Map(manifest.map((entry) => [entry.packageName, entry]));
  const memo = new Map<string, boolean>();
  const isAllowed = (name: string, seen: Set<string>): boolean => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const entry = byName.get(name);
    let result: boolean;
    if (!entry || entry.excluded || seen.has(name)) result = false;
    else if (!entry.partOf) result = true;
    else result = isAllowed(entry.partOf, new Set([...seen, name]));
    memo.set(name, result);
    return result;
  };
  const allowed = new Set<string>();
  for (const entry of manifest)
    if (isAllowed(entry.packageName, new Set())) allowed.add(entry.packageName);
  return allowed;
}

/**
 * Namespace for a package entry inside the generic `key` field of
 * `org.setting_changed` / `machine.setting_changed`, so a manifest edit can
 * never collide with a real setting key (`logging_tier`, `persistent_paths`)
 * and so consumers can recognise one by its key alone. Both write paths use
 * this: `MachineService.updatePackages` and
 * `domain/organisation/packages.ts`, which re-exports it for its own callers.
 *
 * `logging/tier-filter.ts` keys its never-drop carve-out off this prefix, and
 * the manifest-history query selects on it.
 */
export const PACKAGE_SETTING_KEY_PREFIX = "package:";

export const packageSettingKey = (packageName: string): string =>
  `${PACKAGE_SETTING_KEY_PREFIX}${packageName}`;

/** Inverse of `packageSettingKey` — `null` when the key is not a package key. */
export const packageNameFromSettingKey = (key: string): string | null =>
  key.startsWith(PACKAGE_SETTING_KEY_PREFIX) ? key.slice(PACKAGE_SETTING_KEY_PREFIX.length) : null;

/**
 * Why an edit's setting cannot be written as asked. Checked at edit time,
 * before any approval is asked for, so an approver is never asked about
 * something that could not be carried out.
 */
export interface EnsureSettingProblem {
  packageName: string;
  reason: "not_installable" | "ensure_latest_with_pin" | "invalid_version_pin";
  message: string;
}

/**
 * The ensure rules that do not depend on anything but the entry itself:
 * Cloudable can only ensure what it can install, and "latest" and a version
 * pin contradict each other. Also, for every setting, a pin on an npm, pipx,
 * cargo or nix package must be a version that manager understands
 * (`isValidVersionPin`): it becomes that manager's argument on the machine. apt
 * pins are left as they were, free text apt itself judges.
 */
export function findEnsureSettingProblems(
  entries: ReadonlyArray<{
    packageName: string;
    setting: PackageSetting;
    versionPin: string | null;
  }>,
): EnsureSettingProblem[] {
  const problems: EnsureSettingProblem[] = [];
  for (const entry of entries) {
    const manager = parseDeclaredPackageName(entry.packageName)?.manager;
    if (
      entry.versionPin !== null &&
      manager !== undefined &&
      manager !== "apt" &&
      manager !== "home" &&
      !isValidVersionPin(entry.packageName, entry.versionPin)
    ) {
      problems.push({
        packageName: entry.packageName,
        reason: "invalid_version_pin",
        message:
          manager === "nix"
            ? `"${entry.versionPin}" is not a nixpkgs commit. A nix: pin is a full 40-character commit.`
            : `"${entry.versionPin}" is not a version ${manager} understands.`,
      });
      continue;
    }
    if (entry.setting === "allowed") continue;
    if (!isInstallablePackageName(entry.packageName)) {
      problems.push({
        packageName: entry.packageName,
        reason: "not_installable",
        message: `Cloudable cannot install "${entry.packageName}", so it cannot ensure it.`,
      });
    } else if (entry.setting === "ensure_latest" && entry.versionPin !== null) {
      problems.push({
        packageName: entry.packageName,
        reason: "ensure_latest_with_pin",
        message: `"${entry.packageName}" has a version pin, so it cannot be set to Ensure latest version.`,
      });
    }
  }
  return problems;
}

export interface LockConflict {
  packageName: string;
  lockedAtScope: ManifestScope;
  lockedAtScopeId: string;
  lockedVersionPin: string | null;
}

const SCOPE_RANK: Record<ManifestScope, number> = { org: 0, profile: 1, machine: 2 };

/**
 * The organisation can mark an entry locked. A locked entry
 * cannot be overridden below. Attempting to override one is a validation
 * error at edit time, not a silent no-op at reconcile.
 *
 * Returns one conflict per edited package name that has a locked row at a
 * *higher* scope than `targetScope` (org/profile lock blocking a machine
 * edit, org lock blocking a profile edit). An edit at the same scope that
 * owns the lock, or at a higher scope than any existing lock, is not an
 * override-below and is never reported.
 */
export function findLockConflicts(
  existingRows: ReadonlyArray<MachinePackageRow>,
  targetScope: ManifestScope,
  editedPackageNames: ReadonlyArray<string>,
): LockConflict[] {
  const conflicts: LockConflict[] = [];
  for (const packageName of editedPackageNames) {
    const lockedAbove = existingRows
      .filter(
        (row) =>
          row.packageName === packageName &&
          row.locked &&
          SCOPE_RANK[row.scopeType] < SCOPE_RANK[targetScope],
      )
      // Closest locking scope above the target is the one the edit actually collides with.
      .sort((a, b) => SCOPE_RANK[b.scopeType] - SCOPE_RANK[a.scopeType])[0];
    if (lockedAbove) {
      conflicts.push({
        packageName,
        lockedAtScope: lockedAbove.scopeType,
        lockedAtScopeId: lockedAbove.scopeId,
        lockedVersionPin: lockedAbove.versionPin,
      });
    }
  }
  return conflicts;
}

/**
 * Allowlist-detection data path for "no undeclared software".
 * Pure and exported cleanly so the compliance check and the
 * reconcile loop can both consume it without depending on HTTP or the DB.
 *
 * Reconcile only ever *removes* what this returns
 * — this function itself does nothing but compute the set; it has no
 * knowledge of, and no license to trigger, removal.
 */
export function computeUndeclaredPackages(
  manifest: ReadonlyArray<Pick<ResolvedManifestEntry, "packageName" | "excluded">>,
  reported: ReadonlyArray<string>,
): string[] {
  const declared = new Set(
    manifest.filter((entry) => !entry.excluded).map((entry) => entry.packageName),
  );
  const seen = new Set<string>();
  const undeclared: string[] = [];
  for (const packageName of reported) {
    if (!declared.has(packageName) && !seen.has(packageName)) {
      seen.add(packageName);
      undeclared.push(packageName);
    }
  }
  return undeclared;
}
