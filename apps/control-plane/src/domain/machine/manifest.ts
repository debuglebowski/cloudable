import { type SettingRow, resolveSetting } from "@cloudable/schema";

/** See `docs/inheritance.md` for the full write-up of this chain. */
export type ManifestScope = "org" | "template" | "machine";

export interface ManifestScopeChain {
  orgId: string;
  templateId?: string | null;
  machineId: string;
}

/** Mirrors the `machine_packages` table row shape (`packages/schema/src/tables/machine-package.ts`). */
export interface MachinePackageRow {
  scopeType: ManifestScope;
  scopeId: string;
  packageName: string;
  versionPin: string | null;
  pinned: boolean;
  source: ManifestScope;
}

export interface PackageManifestValue {
  versionPin: string | null;
  pinned: boolean;
}

export interface ResolvedManifestEntry {
  packageName: string;
  versionPin: string | null;
  pinned: boolean;
  /** Which scope level's row won resolution — feeds `LineageGutter`/`SettingRow` (docs/frontend.md). */
  source: ManifestScope;
  resolvedFromScopeId: string;
}

/**
 * Resolve the effective package manifest for a machine across the
 * org → template → machine chain (lowest level wins).
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
    value: { versionPin: row.versionPin, pinned: row.pinned },
    source: row.source,
  }));

  const resolved: ResolvedManifestEntry[] = [];
  for (const packageName of packageNames) {
    const winner = resolveSetting(packageName, settingRows, chain);
    if (!winner) continue;
    resolved.push({
      packageName,
      versionPin: winner.value.versionPin,
      pinned: winner.value.pinned,
      source: winner.source,
      resolvedFromScopeId: winner.resolvedFromScopeId,
    });
  }
  return resolved.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export interface PinConflict {
  packageName: string;
  pinnedAtScope: ManifestScope;
  pinnedAtScopeId: string;
  pinnedVersionPin: string | null;
}

const SCOPE_RANK: Record<ManifestScope, number> = { org: 0, template: 1, machine: 2 };

/**
 * The organisation can mark an entry pinned. A pinned entry
 * cannot be overridden below. Attempting to override one is a validation
 * error at edit time, not a silent no-op at reconcile.
 *
 * Returns one conflict per edited package name that has a pinned row at a
 * *higher* scope than `targetScope` (org/template pin blocking a machine
 * edit, org pin blocking a template edit). An edit at the same scope that
 * owns the pin, or at a higher scope than any existing pin, is not an
 * override-below and is never reported.
 */
export function findPinConflicts(
  existingRows: ReadonlyArray<MachinePackageRow>,
  targetScope: ManifestScope,
  editedPackageNames: ReadonlyArray<string>,
): PinConflict[] {
  const conflicts: PinConflict[] = [];
  for (const packageName of editedPackageNames) {
    const pinnedAbove = existingRows
      .filter(
        (row) =>
          row.packageName === packageName &&
          row.pinned &&
          SCOPE_RANK[row.scopeType] < SCOPE_RANK[targetScope],
      )
      // Closest pinning scope above the target is the one the edit actually collides with.
      .sort((a, b) => SCOPE_RANK[b.scopeType] - SCOPE_RANK[a.scopeType])[0];
    if (pinnedAbove) {
      conflicts.push({
        packageName,
        pinnedAtScope: pinnedAbove.scopeType,
        pinnedAtScopeId: pinnedAbove.scopeId,
        pinnedVersionPin: pinnedAbove.versionPin,
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
  manifest: ReadonlyArray<Pick<ResolvedManifestEntry, "packageName">>,
  reported: ReadonlyArray<string>,
): string[] {
  const declared = new Set(manifest.map((entry) => entry.packageName));
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
